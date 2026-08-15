import { Menu, createMenu, startMenu } from 'pathux';
import type { Button, Container, MenuTemplate, MenuTemplateCustom } from 'pathux';
import { EFFORT_LEVELS, TEXT_MODELS, supportsEffort } from '@vn/types';
import { allow, answer, ask, convo, decide, revision, takeSeed } from '../agent.js';
import { exec, setEffort, setModel, toggleMode } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openPalette } from '../palette.js';
import STUDIO_CSS from '../../styles/studio.css?inline';
import type { FeedItem, ThreadHeader } from '../../../src/shared/convo.js';
import type { AskRequest, ConfirmRequest, Plan } from '../../../src/shared/ipc.js';

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

/* A plan is the machine proposing, so it is signal. A question and a confirmation are the
   author's own turn to take — sodium, the same warm the header uses for the human side. */
.cv-surface .plan.ask,
.cv-surface .plan.confirm {
  border-color: rgba(244, 162, 76, 0.4);
  background: linear-gradient(180deg, rgba(244, 162, 76, 0.07), rgba(244, 162, 76, 0.015));
}
.cv-surface .plan.ask .plan-head,
.cv-surface .plan.confirm .plan-head {
  color: var(--sodium);
}
.cv-surface .ask-input {
  width: 100%;
  margin-bottom: 12px;
  background: var(--ink-sunken);
  border: 1px solid var(--ink-line);
  border-radius: var(--r-soft);
  padding: 10px 13px;
  color: var(--paper);
  font: inherit;
  font-size: 13.5px;
}
.cv-surface .ask-input:focus {
  outline: none;
  border-color: var(--sodium);
}

/* Openers offered by whatever started this conversation. Between the dialogue box and the
   composer, because that is the gap the eye crosses on the way to typing — and they *fill* the
   composer, so they read as drafts rather than as buttons that do something. */
.cv-surface .chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.cv-surface .chips button {
  border: 1px solid var(--ink-line);
  border-radius: 999px;
  background: var(--ink-raised);
  color: var(--mist);
  font-size: 12.5px;
  padding: 6px 13px;
  text-align: left;
}
.cv-surface .chips button:hover {
  color: var(--paper);
  border-color: var(--sodium);
}
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
  /** The one word said while a turn is in flight; a CSS animation does the rest. */
  private workingEl!: HTMLDivElement;
  /** Where `Convo.suggestions` are drawn. Empty for every conversation nobody seeded. */
  private chipsEl!: HTMLDivElement;
  /** Kept because the thread menu opens under it, and only the button knows where that is. */
  private threadsBtn!: Button;
  private drawn = -1;
  /** The three bar facts that live in `ShellState` rather than in the conversation. */
  private barKey = '';
  /** The question id whose box already took focus, so a redraw does not steal the caret back. */
  private focusedAsk = -1;
  /** What the question box holds. The transcript is rebuilt wholesale; the half-typed answer isn't. */
  private askDraft = '';

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
    if (this.stateKey() !== this.barKey) this.rebuildBar();
  }

  /** What the bar draws from. Three session facts, none of them the conversation's. */
  private stateKey(): string {
    const ui = this.ui;
    return `${ui.agentMode}|${ui.model}|${ui.effort}`;
  }

  /**
   * The bar the author reads before typing. The header carries the same mode toggle, but this is
   * the pane a turn is entered into, so it is the pane that has to say whether typing edits files.
   */
  private rebuildBar(): void {
    this.barKey = this.stateKey();
    const ui = this.ui;

    this.bar.clear();
    this.bar.label('VNAUTHOR').style['padding'] = '0px 8px';
    this.bar.button(ui.agentMode === 'plan' ? 'PLAN' : 'EXECUTE', () => void toggleMode());

    const models: MenuTemplate = TEXT_MODELS.map((id) => [
      id,
      () => void setModel(id),
      undefined,
    ]) as MenuTemplate;
    this.bar.menu(ui.model || 'model…', models);

    const efforts: MenuTemplate = ['default', ...EFFORT_LEVELS].map((level) => [
      level,
      () => void setEffort(level),
      undefined,
    ]) as MenuTemplate;
    const effort = this.bar.menu(`effort: ${ui.effort}`, efforts);
    // A model with no thinking knob gets the menu greyed rather than hidden — the setting is kept
    // across a model switch, so what the author picked is still true, it is just not in use.
    if (!supportsEffort(ui.model)) {
      effort.disabled = true;
      effort.description = `${ui.model || 'this model'} has no reasoning-effort setting.`;
    }

    this.threadsBtn = this.bar.button('Threads', () => void this.showThreads());
    this.threadsBtn.description =
      'Saved conversations. Reopening one is read-only — the agent is not shown it.';

    // Through the registry: the transcript follows `agent.clear` itself, so clearing from here
    // and clearing from the palette are one act with one record.
    this.bar.button('Clear', () => void exec('agent.clear'));
    this.bar.flushUpdate();
  }

  /**
   * The saved conversations, as path.ux's *fancy* menu — the one boolean that turns a menu into a
   * searchable one, which is all a list that only ever grows needs.
   *
   * The list is fetched on the click rather than held on the pane: threads are written by main as
   * a turn runs, so anything cached here would be a menu that does not list the conversation the
   * author is having.
   *
   * Every row carries an explicit id in the last slot. `createMenu` reads `item[5]` for any row
   * longer than four, so a row with a **tooltip** and no id is registered under `undefined` and
   * its callback is never found — the click lands, the menu closes, and nothing happens.
   */
  private async showThreads(): Promise<void> {
    const outcome = await exec('agent.threads');
    if (!outcome.ok) return;
    const { threads, active } = outcome.data as { threads: ThreadHeader[]; active?: string };

    const rows: MenuTemplateCustom[] = threads.map((thread) => [
      `${thread.id === active ? '• ' : ''}${label(thread)}`,
      () => void exec('agent.openThread', { id: thread.id }),
      undefined,
      undefined,
      detail(thread),
      thread.id,
    ]);
    if (rows.length === 0)
      rows.push(['(nothing saved yet)', () => {}, undefined, undefined, '', 'none']);

    const templ: MenuTemplate = [
      ...rows,
      Menu.SEP,
      [
        'New conversation',
        () => void exec('agent.newThread'),
        undefined,
        undefined,
        'Save this one and start again.',
        'new',
      ] as MenuTemplateCustom,
    ];

    const menu = createMenu(this.ctx, 'Conversations', templ);
    const rect = this.threadsBtn.getBoundingClientRect();
    startMenu(menu, rect.x, rect.y + rect.height, true, 0);
  }

  /** The dialogue box and the composer: the same element whatever the transcript is doing. */
  private stage(): HTMLElement {
    const stage = el('div', 'stage');

    const dbox = el('div', 'dbox');
    dbox.appendChild(el('div', 'nameplate', 'VNAUTHOR'));
    this.lineEl = el('div', 'line') as HTMLDivElement;
    dbox.appendChild(this.lineEl);
    // Built once, shown while busy: a turn that says nothing for thirty seconds is otherwise
    // indistinguishable from one that never started. One word, and `@keyframes` moves it.
    this.workingEl = el('div', 'working', 'working') as HTMLDivElement;
    dbox.appendChild(this.workingEl);
    stage.appendChild(dbox);

    this.chipsEl = el('div', 'chips') as HTMLDivElement;
    stage.appendChild(this.chipsEl);

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
    this.workingEl.style.display = state.busy ? 'block' : 'none';
    this.drawChips(state.suggestions);

    this.transcript.textContent = '';
    if (state.feed.length === 0 && !state.plan && !state.question && !state.confirm) {
      this.transcript.appendChild(
        el('div', 'empty-hint', 'Ask vnauthor to change a character, scene, or location.'),
      );
    }
    for (const item of state.feed) this.transcript.appendChild(this.turn(item));
    if (state.plan) this.transcript.appendChild(this.planCard(state.plan.plan));
    if (state.question) this.transcript.appendChild(this.askCard(state.question));
    if (state.confirm) this.transcript.appendChild(this.confirmCard(state.confirm));
    // The transcript is bottom-aligned, so what just happened is what is on screen.
    this.transcript.scrollTop = this.transcript.scrollHeight;

    const seeded = takeSeed();
    if (seeded !== null) {
      this.input.value = seeded;
      this.input.focus();
      this.input.setSelectionRange(seeded.length, seeded.length);
    }
  }

  /**
   * The openers, as chips. Clicking one **fills** the composer and focuses it — it does not send.
   * The chip is there to teach the shape of a useful prompt, and sending it would remove the one
   * moment where the author edits it into what they actually meant.
   */
  private drawChips(suggestions: readonly string[]): void {
    this.chipsEl.textContent = '';
    for (const text of suggestions) {
      const chip = document.createElement('button');
      chip.textContent = text;
      chip.addEventListener('click', () => {
        this.input.value = text;
        this.input.focus();
        this.input.setSelectionRange(text.length, text.length);
      });
      this.chipsEl.appendChild(chip);
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

  /**
   * The agent asked something and its turn is parked on the answer. It wears the plan card's
   * shape because it is the same kind of moment — the conversation stopped, waiting on the author
   * — and the box takes focus on arrival, since nothing else on this pane is worth typing into.
   */
  private askCard(request: AskRequest): HTMLElement {
    const card = el('div', 'plan ask');
    card.appendChild(el('div', 'plan-head', 'VNAUTHOR ASKS'));

    const body = el('div', 'plan-body');
    body.appendChild(el('div', 'plan-sum', request.question));

    const field = document.createElement('input');
    field.className = 'ask-input';
    field.placeholder = 'Answer, or press Enter to say nothing…';
    field.value = this.askDraft;
    field.addEventListener('input', () => (this.askDraft = field.value));
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') this.reply();
    });
    body.appendChild(field);

    const acts = el('div', 'plan-acts');
    const send = document.createElement('button');
    send.className = 'btn primary';
    send.textContent = 'Answer →';
    send.addEventListener('click', () => this.reply());
    acts.appendChild(send);
    body.appendChild(acts);

    card.appendChild(body);
    if (this.focusedAsk !== request.id) {
      this.focusedAsk = request.id;
      // The card is not in the document until `rebuild` has appended it.
      queueMicrotask(() => field.focus());
    }
    return card;
  }

  private reply(): void {
    const text = this.askDraft;
    this.askDraft = '';
    answer(text);
  }

  /**
   * An always-confirm tool, waiting. Deny comes first and is the unaccented one: the author is
   * being asked to spend money or rewrite history, so the accented button is never the one the
   * hand lands on by default.
   */
  private confirmCard(request: ConfirmRequest): HTMLElement {
    const card = el('div', 'plan confirm');
    card.appendChild(el('div', 'plan-head', `CONFIRM · ${request.tool}`));

    const body = el('div', 'plan-body');
    body.appendChild(el('div', 'plan-sum', request.detail));

    const acts = el('div', 'plan-acts');
    acts.appendChild(this.allowBtn('Deny', 'btn', false));
    acts.appendChild(this.allowBtn('Allow →', 'btn primary', true));
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  private allowBtn(label: string, className: string, allowed: boolean): HTMLElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => allow(allowed));
    return button;
  }
}

/**
 * A thread's menu row: what it was about, and when. The date is short because the title is the
 * part being searched, and it is dropped entirely rather than rendered as `Invalid Date` — a log
 * old enough to have a header this reader does not understand is still a log worth opening.
 */
function label(thread: ThreadHeader): string {
  const at = new Date(thread.startedAt);
  if (Number.isNaN(at.getTime())) return thread.title;
  const when = at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${thread.title} · ${when}`;
}

/** The tooltip: the facts the row had no room for. */
function detail(thread: ThreadHeader): string {
  const at = new Date(thread.startedAt);
  const parts = [Number.isNaN(at.getTime()) ? thread.startedAt : at.toLocaleString()];
  if (thread.model) parts.push(thread.model);
  if (thread.commit) parts.push(thread.commit.slice(0, 8));
  return parts.join(' · ');
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(ConvoEditor, 'vn.ConvoEditor');
