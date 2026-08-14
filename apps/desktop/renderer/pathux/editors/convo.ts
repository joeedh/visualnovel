import type { Container } from 'pathux';
import { ask, convo, decide, revision, takeSeed } from '../agent.js';
import { exec } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openPalette } from '../palette.js';
import STUDIO_CSS from '../../styles/studio.css?inline';
import type { FeedItem } from '../convo.js';
import type { Plan } from '../../../src/shared/ipc.js';

/**
 * What the room supplied and the pane does not. `studio.css` is imported as-is — the transcript,
 * the dialogue box and the plan card are the React shell's, down to the sodium glow — so this is
 * only the frame: the reset that does not cross the shadow boundary, and `.convo` filling the
 * surface instead of a grid column of `.studio`.
 */
const SURFACE_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
.convo.cv-surface {
  height: 100%;
  background: var(--ink);
  color: var(--paper);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
}
.cv-surface button { font-family: inherit; color: inherit; cursor: pointer; }
.cv-surface .composer .send:disabled { opacity: 0.45; cursor: default; }
`;

/**
 * The vnauthor conversation: the transcript, the plan card, the dialogue box and the composer.
 * The port of STUDIO's `Convo` + `useAgent`, and the last of the seven.
 *
 * It also *unnests*. In the React shell the branch and script editors were passed to this
 * component as a `surface` prop and rendered **inside** it, which is why they could not be open
 * at once and why the composer had to survive their swap. Here they are areas of the screen
 * mesh, so the conversation is a pane like any other and the author decides whether it shares
 * the window with the page it is about.
 *
 * The conversation itself is not held here — `agent.ts` holds it, subscribed at boot — because
 * the agent streams whether or not this pane is open, and a pane opened afterwards has to show
 * what was already said.
 */
export class ConvoEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;
  private transcript!: HTMLDivElement;
  private lineEl!: HTMLDivElement;
  /**
   * The composer, built once and never rebuilt. It is what the author is typing into and what a
   * seed lands in, so it outlives every redraw of the transcript above it.
   */
  private input!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private drawn = -1;

  static override define() {
    return {
      tagname: 'vn-convo-editor-x',
      areaname: 'convo',
      uiname: 'Convo',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.bar = (this.header as Container).row();
    this.rebuildBar();

    this.adoptStyle(STUDIO_CSS + SURFACE_CSS);
    this.surface = el('div', 'convo cv-surface') as HTMLDivElement;
    this.transcript = el('div', 'transcript') as HTMLDivElement;
    this.surface.appendChild(this.transcript);
    this.surface.appendChild(this.stage());
    this.appendSurface(this.surface);

    this.rebuild();
  }

  override update() {
    super.update();

    if (revision() !== this.drawn) this.rebuild();
  }

  private rebuildBar(): void {
    this.bar.clear();
    this.bar.label('VNAUTHOR').style['padding'] = '0px 8px';
    // Both through the registry: the transcript follows `agent.clear` itself, so clearing from
    // here and clearing from the palette are one act with one record.
    this.bar.button('Clear', () => void exec('agent.clear'));
    this.bar.flushUpdate();
  }

  /** The dialogue box and the composer: the same element whatever the transcript is doing. */
  private stage(): HTMLElement {
    const stage = el('div', 'stage');

    const dbox = el('div', 'dbox');
    dbox.appendChild(el('div', 'nameplate', 'VNAUTHOR'));
    this.lineEl = el('div', 'line') as HTMLDivElement;
    dbox.appendChild(this.lineEl);
    stage.appendChild(dbox);

    const composer = el('div', 'composer');
    this.input = document.createElement('input');
    this.input.name = 'composer';
    this.input.placeholder = 'Reply to vnauthor, or ask for a change…';
    // The shell keymap is a bubble-phase window listener, so a composer that does not stop its
    // own keys opens the palette on the first `/` the author types.
    this.input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') this.send();
    });
    composer.appendChild(this.input);

    const slash = document.createElement('button');
    slash.className = 'cmdbtn';
    slash.textContent = '/';
    slash.title = 'Commands & skills (/)';
    slash.addEventListener('click', () => openPalette());
    composer.appendChild(slash);

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'send';
    this.sendBtn.textContent = '↑';
    this.sendBtn.title = 'Send';
    this.sendBtn.addEventListener('click', () => this.send());
    composer.appendChild(this.sendBtn);

    stage.appendChild(composer);
    return stage;
  }

  private send(): void {
    const text = this.input.value;
    if (!text.trim()) return;
    this.input.value = '';
    void ask(text);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.drawn = revision();
    const state = convo();

    this.lineEl.textContent = state.line;
    this.sendBtn.disabled = state.busy;

    this.transcript.textContent = '';
    if (state.feed.length === 0 && !state.plan) {
      this.transcript.appendChild(
        el('div', 'empty-hint', 'Ask vnauthor to change a character, scene, or location.'),
      );
    }
    for (const item of state.feed) this.transcript.appendChild(this.turn(item));
    if (state.plan) this.transcript.appendChild(this.planCard(state.plan.plan));
    // The transcript is bottom-aligned, so what just happened is what is on screen.
    this.transcript.scrollTop = this.transcript.scrollHeight;

    const seeded = takeSeed();
    if (seeded !== null) {
      this.input.value = seeded;
      this.input.focus();
      this.input.setSelectionRange(seeded.length, seeded.length);
    }
  }

  private turn(item: FeedItem): HTMLElement {
    if (item.role === 'user') {
      const turn = el('div', 'turn-user');
      turn.appendChild(el('div', 'who', 'AUTHOR'));
      turn.appendChild(el('div', 'bubble', item.text));
      return turn;
    }
    // A tool call and a refusal are the same shape — the verb carries the colour, so a blocked
    // one reads as the same act, stopped.
    const action = el('div', item.role === 'blocked' ? 'action blocked' : 'action');
    action.appendChild(el('span', item.role === 'agent' ? '' : 'verb', item.text));
    return action;
  }

  /** The gate between plan mode and execute mode, as a card in the transcript. */
  private planCard(plan: Plan): HTMLElement {
    const card = el('div', 'plan');
    card.appendChild(el('div', 'plan-head', 'PROPOSED PLAN'));

    const body = el('div', 'plan-body');
    body.appendChild(el('div', 'plan-sum', plan.summary));

    const steps = el('ol', 'plan-steps');
    for (const [i, step] of plan.steps.entries()) {
      const li = document.createElement('li');
      li.appendChild(el('span', 'n', String(i + 1).padStart(2, '0')));
      li.appendChild(el('span', '', step));
      steps.appendChild(li);
    }
    body.appendChild(steps);

    const acts = el('div', 'plan-acts');
    acts.appendChild(this.decideBtn('Reject', 'btn', false));
    acts.appendChild(this.decideBtn('Approve →', 'btn primary', true));
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  private decideBtn(label: string, className: string, approved: boolean): HTMLElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => void decide(approved));
    return button;
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(ConvoEditor, 'vn.ConvoEditor');
