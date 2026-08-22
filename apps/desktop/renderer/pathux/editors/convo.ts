import { Menu, createMenu, startMenu } from 'pathux';
import type { Button, Container, DropBox, Label, MenuTemplate, MenuTemplateCustom } from 'pathux';
import { BUDGET_CHOICES, TEXT_MODELS, budgetLabel, effortChoicesFor, effortLabel } from '@vn/types';
import { allow, answer, ask, convo, decide, revision, takeSeed } from '../agent.js';
import { exec, report, setBudget, setEffort, setModel, toggleMode } from '../bridge.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openPalette } from '../palette.js';
import STUDIO_CSS from '../../styles/studio.css?inline';
import {
  threadDetail,
  threadLabel,
  tokensDetail,
  uncachedTokens,
  type FeedItem,
  type ThreadHeader,
} from '../../../src/shared/convo.js';
import {
  answersOf,
  answersOnPick,
  blankPages,
  goTo,
  isFirst,
  isLast,
  isPicked,
  pageLabel,
  pageOf,
  pick,
  startForm,
  type,
  type AskForm,
} from '../../rules/askform.js';
import type { AskRequest, ConfirmRequest, Plan } from '../../../src/shared/ipc.js';

/**
 * The frame around `studio.css`, which is imported as-is: the transcript, the dialogue box and the
 * plan card are the React shell's, down to the sodium glow. This supplies the reset that does not
 * cross the shadow boundary, and `.convo` filling the surface instead of a grid column of
 * `.studio`.
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

/* Stop takes Send's shape and stands where the eye is already going, but only while a turn is in
   flight — an idle composer has nothing to interrupt, and a permanently greyed square would say
   otherwise. Vermilion, the one colour this shell spends on stopping things. */
.cv-surface .composer .stop {
  width: 40px;
  height: 40px;
  border-radius: var(--r-soft);
  border: 1px solid var(--ink-line);
  background: var(--ink-raised);
  place-items: center;
  color: var(--vermilion);
  font-size: 13px;
}
.cv-surface .composer .stop:hover {
  border-color: var(--vermilion);
}

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

/* The shortlist on an ask card. Full-width rows rather than chips: these are answers, and an
   answer is read before it is clicked, so it gets a line of its own. */
.cv-surface .ask-choices {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.cv-surface .ask-choices button {
  border: 1px solid var(--ink-line);
  border-radius: var(--r-soft);
  background: var(--ink-sunken);
  color: var(--paper);
  font-size: 13.5px;
  padding: 9px 13px;
  text-align: left;
}
.cv-surface .ask-choices button:hover {
  border-color: var(--sodium);
}
.cv-surface .ask-choices button.picked {
  border-color: var(--sodium);
  background: rgba(244, 162, 76, 0.12);
}

/* Where the author is in a form of several. It sits in the card's own head rather than above the
   question, so the question itself is still the first thing read. */
.cv-surface .plan.ask .plan-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.cv-surface .ask-page {
  color: var(--mist-dim);
  letter-spacing: 0.08em;
}
/* Paging goes left, away from the button that ends the form: a mis-aimed click should not
   submit a form the author was only stepping through. */
.cv-surface .ask-nav {
  display: flex;
  gap: 9px;
  margin-right: auto;
}
.cv-surface .ask-nav button:disabled {
  opacity: 0.45;
  cursor: default;
}
`;

/**
 * The vnauthor conversation: the transcript, the plan card, the dialogue box and the composer.
 * The port of STUDIO's `Convo` + `useAgent`.
 *
 * The port also unnests. In the React shell the branch and script editors were passed to this
 * component as a `surface` prop and rendered inside it, which is why they could not be open at
 * once and why the composer had to survive their swap. Here they are areas of the screen mesh, so
 * the conversation is a pane like any other and the author decides whether it shares the window
 * with the page it is about.
 *
 * The conversation itself lives in `agent.ts`, subscribed at boot, rather than here: the agent
 * streams whether or not this pane is open, and a pane opened afterwards has to show what was
 * already said.
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
  /** Shown only while a turn is in flight; `agent.stop` refuses an idle agent by name anyway. */
  private stopBtn!: HTMLButtonElement;
  /** The one word said while a turn is in flight; a CSS animation does the rest. */
  private workingEl!: HTMLDivElement;
  /** Where `Convo.suggestions` are drawn. Empty unless the conversation was seeded with some. */
  private chipsEl!: HTMLDivElement;
  /** Kept because the thread menu opens under it, and only the button knows where that is. */
  private threadsBtn!: Button;
  /**
   * The running token total. Retitled in place rather than keyed into {@link stateKey}: a step
   * finishing would otherwise rebuild the whole bar mid-turn, closing any menu open over it.
   */
  private tokensLbl?: Label;
  private budgetMenu?: DropBox;
  private drawn = -1;
  /**
   * What {@link sayBudget} last painted. The ceiling is deliberately outside {@link stateKey},
   * because a bar rebuilt under an open menu closes it mid-choice, so nothing else notices the
   * author picking one and without this key the label would show the old number until the next
   * turn bumped the revision.
   */
  private budgetKey = '';
  /** The three bar facts that live in `ShellState` rather than in the conversation. */
  private barKey = '';
  /** The form page whose box already took focus, so a redraw does not steal the caret back. */
  private focusedAsk = '';
  /**
   * The form being filled in — which page, what is ticked on each, what is typed beside it. The
   * transcript is rebuilt wholesale and a half-answered form is not: it is the author's work, and
   * an event arriving mid-answer must not throw it away. Cleared when the answers go back.
   */
  private askForm: AskForm | null = null;
  /** The live Submit answers button, so typing can keep its tooltip's blank count true. */
  private sendAct: HTMLButtonElement | null = null;
  /**
   * The ask card's element, kept so a rebuild the author did not cause reattaches it rather than
   * rebuilding it. `rebuild` replaces the transcript wholesale, and a redraw landing between a
   * click's press and its release detaches the row under the pointer — the click then never
   * fires, and the author's pick silently goes nowhere. The two keys say when the card is
   * genuinely stale: a different request, or a form the author has since moved.
   */
  private askCardEl: HTMLElement | null = null;
  private askCardRequest: AskRequest | null = null;
  private askCardForm: AskForm | null = null;

  static override define() {
    return {
      tagname: 'vn-convo-editor-x',
      areaname: 'convo',
      icon: -1,
    };
  }

  override init() {
    super.init();

    // A column of two rows rather than one long row: the bar carries eleven controls, and a
    // single row pushes the last of them off the end of any pane narrower than the window.
    this.bar = (this.header as Container).col();
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
    if (this.budgetSay() !== this.budgetKey) this.sayBudget();
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
    // Row one is what a turn is answered with; row two is what it costs and where it is kept
    const top = this.bar.row();
    const low = this.bar.row();

    top.label('VNAUTHOR').style['padding'] = '0px 8px';
    const mode = top.button(ui.agentMode === 'plan' ? 'PLAN' : 'EXECUTE', () => void toggleMode());
    mode.description =
      ui.agentMode === 'plan'
        ? 'Plan mode: the agent reads and proposes, and edits nothing. Click to let it edit.'
        : 'Execute mode: the agent edits files. Click to go back to reading only.';

    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined.
    const models: MenuTemplate = TEXT_MODELS.map((id) => [
      id,
      () => void setModel(id),
      undefined,
      undefined,
      `Answer with ${id} from the next turn on.`,
      id,
    ]) as MenuTemplate;
    const model = top.menu(ui.model || 'model…', models);
    model.description = 'Which model answers. Switching takes effect on the next turn.';

    // Offers only the levels this model takes: `xhigh` is not a Sonnet 4.6 level, and Fable
    // thinks unconditionally, so it is never offered `no thinking`
    const offered = effortChoicesFor(ui.model);
    const efforts: MenuTemplate = offered.map((choice) => [
      effortLabel(choice),
      () => void setEffort(choice),
      undefined,
      undefined,
      `Think at ${effortLabel(choice)} from the next turn on.`,
      choice,
    ]) as MenuTemplate;
    const effort = top.menu(`effort: ${effortLabel(ui.effort)}`, efforts);
    effort.description = 'How hard the model thinks before answering. Higher costs more.';
    // A model with no thinking knob gets the menu greyed rather than hidden — the setting is kept
    // across a model switch, so what the author picked is still true, it is just not in use.
    if (offered.length === 0) {
      effort.disabled = true;
      effort.description = `${ui.model || 'this model'} has no reasoning-effort setting.`;
    }

    // The turn ceiling. Deliberately outside `stateKey`: the label is retitled in place by
    // `sayBudget`, because rebuilding the bar under an open menu closes it mid-choice.
    const budgets: MenuTemplate = BUDGET_CHOICES.map((choice) => [
      budgetLabel(choice),
      () => void setBudget(choice),
      undefined,
      undefined,
      choice === 'unlimited'
        ? 'Let a turn run until it finishes or hits the 200-step runaway stop.'
        : `Stop a turn once it has spent ${choice} tokens the cache did not serve.`,
      choice,
    ]) as MenuTemplate;
    this.budgetMenu = low.menu('', budgets);
    this.sayBudget();

    this.tokensLbl = low.label('');
    this.tokensLbl.setCSSAfter(() => (this.tokensLbl!.style['padding'] = '0px 8px'));
    this.sayTokens();

    this.threadsBtn = low.button('Threads', () => void this.showThreads());
    this.threadsBtn.description =
      'Saved conversations. Reopening one is read-only — the agent is not shown it.';

    // Beside the list rather than only inside it: starting a fresh conversation is the commonest
    // thing anyone opens that menu for, and it is one gesture, not two.
    const fresh = low.button('New', () => void exec('agent.newThread'));
    fresh.description =
      'Save this conversation and start a fresh one in plan mode. Nothing is lost — the old one ' +
      'stays under Threads.';

    this.bar.flushUpdate();
  }

  /**
   * The ceiling, and what the turn in flight has spent against it. Retitled in place rather than
   * rebuilt, so a click that opens the menu is not undone by the next usage event arriving.
   */
  private budgetSay(): string {
    return `${this.ui.budget}|${convo().turnSpend}`;
  }

  private sayBudget(): void {
    this.budgetKey = this.budgetSay();
    if (!this.budgetMenu) return;
    const choice = this.ui.budget;
    const spent = convo().turnSpend;
    // Through the attribute rather than a field: `updateName` is what notices the change and
    // re-measures the canvas the label is painted on.
    this.budgetMenu.setAttribute(
      'name',
      spent === 0 || choice === 'unlimited'
        ? `budget ${choice}`
        : `budget ${compact(spent)}/${choice}`,
    );
    const limit =
      choice === 'unlimited'
        ? 'This turn runs until it finishes or hits the 200-step runaway stop.'
        : `This turn stops once it has spent ${choice}.`;
    this.budgetMenu.description =
      `What one turn may spend, counting fresh input and output but not what the cache served. ` +
      `${limit} ` +
      (spent === 0
        ? 'Nothing spent on the last turn yet.'
        : `${spent.toLocaleString()} spent on this turn so far.`) +
      ' The setting is remembered between sessions.';
  }

  /**
   * The running total: what has been spent on this conversation, not on this turn. It reads `—`
   * until a provider reports something, because a mock backend and a backend that does not report
   * usage are both `0`, and `0` would look like a bug.
   *
   * It counts the uncached half, fresh input plus output. Total input climbs by the whole cached
   * prefix on every step of a long turn, so a counter reading it would say a one-sentence answer
   * cost forty thousand tokens. The full split is in the tooltip.
   */
  private sayTokens(): void {
    if (!this.tokensLbl) return;
    const tokens = convo().tokens;
    const counted = tokens.input + tokens.output === 0 ? 0 : uncachedTokens(tokens);
    this.tokensLbl.text = counted === 0 ? 'tokens —' : `tokens ${compact(counted)}`;
    this.tokensLbl.description = tokensDetail(tokens);
  }

  /**
   * The saved conversations, drawn as path.ux's searchable menu, which is what a list that only
   * grows needs.
   *
   * The list is fetched on the click rather than held on the pane: threads are written by main as
   * a turn runs, so anything cached here would be a menu that does not list the conversation the
   * author is having.
   *
   * Every row carries an explicit id in the last slot. `createMenu` reads `item[5]` for a row
   * longer than four, so a row with a tooltip and no id is registered under `undefined` and its
   * callback is never found: the click lands, the menu closes, and nothing happens.
   */
  private async showThreads(): Promise<void> {
    const outcome = await exec('agent.threads');
    if (!outcome.ok) return;
    const { threads, active } = outcome.data as { threads: ThreadHeader[]; active?: string };

    const rows: MenuTemplateCustom[] = threads.map((thread) => [
      `${thread.id === active ? '• ' : ''}${threadLabel(thread)}`,
      () => void exec('agent.openThread', { id: thread.id }),
      undefined,
      undefined,
      threadDetail(thread),
      thread.id,
    ]);
    if (rows.length === 0)
      rows.push([
        '(nothing saved yet)',
        () => {},
        undefined,
        undefined,
        'A conversation is saved once you have said something in it.',
        'none',
      ]);

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
    // Built once and shown while busy: a turn that says nothing for half a minute is otherwise
    // indistinguishable from one that never started. `@keyframes` animates the one word
    this.workingEl = el('div', 'working', 'working') as HTMLDivElement;
    dbox.appendChild(this.workingEl);
    stage.appendChild(dbox);

    this.chipsEl = el('div', 'chips') as HTMLDivElement;
    stage.appendChild(this.chipsEl);

    const composer = el('div', 'composer');
    this.input = document.createElement('input');
    this.input.name = 'composer';
    this.input.placeholder = 'Reply to vnauthor, or ask for a change…';
    this.input.title = 'Say what you want changed. Enter sends it; the agent answers with a plan.';
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
    slash.title = 'Open the palette and run a command by name (/)';
    slash.addEventListener('click', () => openPalette());
    composer.appendChild(slash);

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'send';
    this.sendBtn.textContent = '↑';
    this.sendBtn.title = 'Send what is in the box to the agent';
    this.sendBtn.addEventListener('click', () => this.send());
    composer.appendChild(this.sendBtn);

    // Through the registry like everything else, so interrupting from here and interrupting from
    // the palette are one act with one record. A turn that ended in the meantime is refused in
    // the command's own words
    this.stopBtn = document.createElement('button');
    this.stopBtn.className = 'stop';
    this.stopBtn.textContent = '■';
    this.stopBtn.title = 'Stop the agent after the step it is on. What it already did is kept.';
    this.stopBtn.addEventListener('click', () => void exec('agent.stop').then(report));
    composer.appendChild(this.stopBtn);

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
    this.sayTokens();
    this.sayBudget();
    this.sendBtn.disabled = state.busy;
    this.stopBtn.style.display = state.busy ? 'grid' : 'none';
    this.workingEl.style.display = state.busy ? 'block' : 'none';
    this.drawChips(state.suggestions);

    // Detaching the reused ask card drops focus to the body even though the node survives, so the
    // caret is restored once the card is back in the document
    const root = this.transcript.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement as HTMLElement | null;
    const refocus = active && this.askCardEl?.contains(active) ? active : null;

    this.transcript.textContent = '';
    if (state.feed.length === 0 && !state.plan && !state.question && !state.confirm) {
      this.transcript.appendChild(
        el('div', 'empty-hint', 'Ask vnauthor to change a character, scene, or location.'),
      );
    }
    for (const item of state.feed) this.transcript.appendChild(this.turn(item));
    if (state.plan) this.transcript.appendChild(this.planCard(state.plan.plan));
    if (state.question) this.transcript.appendChild(this.askCardFor(state.question));
    if (state.confirm) this.transcript.appendChild(this.confirmCard(state.confirm));
    // The transcript is bottom-aligned, so what just happened is what is on screen.
    this.transcript.scrollTop = this.transcript.scrollHeight;
    refocus?.focus();

    const seeded = takeSeed();
    if (seeded !== null) {
      this.input.value = seeded;
      this.input.focus();
      this.input.setSelectionRange(seeded.length, seeded.length);
    }
  }

  /**
   * The openers, as chips. Clicking one fills the composer and focuses it, and sends nothing. The
   * chip teaches the shape of a useful prompt, and sending it would remove the moment where the
   * author edits it into what they actually meant.
   */
  private drawChips(suggestions: readonly string[]): void {
    this.chipsEl.textContent = '';
    for (const text of suggestions) {
      const chip = document.createElement('button');
      chip.textContent = text;
      chip.title = 'Put this in the composer to edit before you send it — clicking sends nothing.';
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
    // A tool call and a refusal use the same shape with the verb coloured differently, so a
    // blocked call reads as the same act stopped
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
    acts.appendChild(
      this.decideBtn(
        'Reject',
        'btn',
        false,
        'Turn this plan down. Nothing is written; say why next.',
      ),
    );
    acts.appendChild(
      this.decideBtn(
        'Approve →',
        'btn primary',
        true,
        'Let the agent carry the plan out and commit it.',
      ),
    );
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  private decideBtn(label: string, className: string, approved: boolean, tip: string): HTMLElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.title = tip;
    button.addEventListener('click', () => void decide(approved));
    return button;
  }

  /**
   * The agent asked something and its turn is parked on the answer. It takes the plan card's shape
   * because it is the same kind of moment, with the conversation stopped and waiting on the author,
   * and the box takes focus on arrival since nothing else on this pane is worth typing into.
   *
   * A request carries a form: usually one question, sometimes several the model wants settled
   * together. Several are drawn one page at a time with ‹ Back / Next › between them and one
   * Submit answers at the end, because a wall of four questions reads as a chore while one
   * question with a pager reads as a question. A single question draws as it always did.
   */
  private askCard(request: AskRequest): HTMLElement {
    const form = this.formFor(request);
    const page = pageOf(form);
    const card = el('div', 'plan ask');
    const head = el('div', 'plan-head', 'VNAUTHOR ASKS');
    const where = pageLabel(form);
    if (where) {
      const pager = el('span', 'ask-page', where);
      pager.title = 'The agent asked these together; answer them all, then submit once.';
      head.appendChild(pager);
    }
    card.appendChild(head);

    const body = el('div', 'plan-body');
    body.appendChild(el('div', 'plan-sum', page?.question ?? ''));

    const choices = page?.choices ?? [];
    const first = choices.length ? this.drawChoices(body, form, choices) : null;
    const field = this.drawAnswerBox(body, form, choices.length > 0);

    body.appendChild(this.drawActs(form, choices.length > 0));
    card.appendChild(body);

    // Keyed per page rather than per request: paging to question 3 puts the caret on question 3,
    // and an event that redraws the card mid-answer leaves the caret where the author put it
    const here = `${request.id}:${form.at}`;
    if (this.focusedAsk !== here) {
      this.focusedAsk = here;
      // The card is not in the document until `rebuild` has appended it. With a list, the list is
      // what the author came to read, so the caret starts there rather than in the box.
      queueMicrotask(() => (first ?? field).focus());
    }
    return card;
  }

  /**
   * The card, reused while nothing about it has changed. Every author-driven change — paging,
   * picking, answering — goes through {@link page} or {@link sendAnswers} and makes a new form
   * or clears the question, so a fresh element is built exactly when the card should look
   * different; a rebuild caused by anything else reattaches the element the author is mid-click
   * on. Typing is the one change that redraws nothing by design, so the input handler keeps the
   * form key in step itself.
   */
  private askCardFor(request: AskRequest): HTMLElement {
    const form = this.formFor(request);
    if (this.askCardEl && this.askCardRequest === request && this.askCardForm === form) {
      return this.askCardEl;
    }
    this.askCardRequest = request;
    this.askCardForm = form;
    this.askCardEl = this.askCard(request);
    return this.askCardEl;
  }

  /** The form for this request, started on arrival and kept until the answers go back. */
  private formFor(request: AskRequest): AskForm {
    if (!this.askForm || this.askForm.questions !== request.questions) {
      this.askForm = startForm(request.questions);
    }
    return this.askForm;
  }

  /** Apply a transition to the form and redraw the card around it. */
  private page(next: AskForm): void {
    this.askForm = next;
    this.rebuild();
  }

  /**
   * The shortlist. On a lone single-pick question a click answers outright — there is nothing
   * else to say — while every other shape ticks and waits, because a form has more pages to fill
   * in and a multi-pick's second choice is the whole point.
   *
   * Returns the first row so the card can start the focus there.
   */
  private drawChoices(body: HTMLElement, form: AskForm, choices: string[]): HTMLButtonElement {
    const multi = pageOf(form)?.multi === true;
    const outright = answersOnPick(form);
    const list = el('div', 'ask-choices');
    const rows = choices.map((choice) => {
      const row = document.createElement('button');
      row.textContent = choice;
      row.title = multi
        ? `Include “${choice}” in your answer. Pick as many as apply.`
        : outright
          ? `Answer “${choice}”.`
          : `Answer “${choice}” to this question. The rest of the form stays as you left it.`;
      if (isPicked(form, choice)) row.classList.add('picked');
      row.addEventListener('click', () => {
        if (outright) return this.sendAnswers([choice]);
        // Picking the last question's answer must not submit: on the last page the pick simply
        // stands, and Submit is the one thing that ends the form.
        const picked = pick(this.askForm ?? form, choice);
        this.page(multi ? picked : goTo(picked, picked.at + 1));
      });
      list.appendChild(row);
      return row;
    });
    body.appendChild(list);
    return rows[0]!;
  }

  /** The free-text box under the list, or instead of it where the question offered none. */
  private drawAnswerBox(body: HTMLElement, form: AskForm, listed: boolean): HTMLInputElement {
    const field = document.createElement('input');
    field.className = 'ask-input';
    field.placeholder = listed
      ? 'Or type an answer of your own…'
      : 'Answer, or press Enter to say nothing…';
    field.title = listed
      ? 'Answer in your own words instead of picking from the list.'
      : 'Answer the question. Sending an empty box says you have nothing to add.';
    field.value = form.typed[form.at] ?? '';
    // Typing does not redraw — that would take the caret away mid-word — so what was typed is
    // written into the form on every keystroke instead, where a redraw will find it again.
    field.addEventListener('input', () => {
      this.askForm = type(this.askForm ?? form, field.value);
      // The element on screen already shows this keystroke, so the card key follows the form:
      // otherwise the next unrelated rebuild would count typing as staleness and rebuild the
      // card, which is exactly the redraw-under-the-pointer this cache exists to prevent.
      this.askCardForm = this.askForm;
      // The tooltip counts what is still blank, and typing is exactly what stops one being blank.
      if (this.sendAct) this.sendAct.title = this.sendTitle(this.askForm, listed);
    });
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key !== 'Enter') return;
      const now = this.askForm ?? form;
      if (isLast(now)) this.reply();
      else this.page(goTo(now, now.at + 1));
    });
    body.appendChild(field);
    return field;
  }

  /** Back / Next on the left, and the one button that ends the form on the right. */
  private drawActs(form: AskForm, listed: boolean): HTMLElement {
    const acts = el('div', 'plan-acts');
    if (form.questions.length > 1) {
      const nav = el('div', 'ask-nav');
      nav.appendChild(
        this.navButton('‹ Back', isFirst(form), 'Go back to the previous question.', () =>
          this.page(goTo(this.askForm ?? form, form.at - 1)),
        ),
      );
      nav.appendChild(
        this.navButton('Next ›', isLast(form), 'Go on to the next question.', () =>
          this.page(goTo(this.askForm ?? form, form.at + 1)),
        ),
      );
      acts.appendChild(nav);
    }

    const send = document.createElement('button');
    send.className = 'btn primary';
    send.textContent = form.questions.length > 1 ? 'Submit answers' : 'Answer →';
    send.title = this.sendTitle(form, listed);
    send.addEventListener('click', () => this.reply());
    this.sendAct = send;
    acts.appendChild(send);
    if (listed) acts.appendChild(this.chatButton(form));
    return acts;
  }

  /**
   * What the one button that ends the form promises. A blank answer is a real answer (the tool
   * exists to hear "nothing to add") so what is still empty is named in the tooltip rather than
   * used to grey the button out. Recomputed on every keystroke, because a stale count would
   * misstate what the author just typed.
   */
  private sendTitle(form: AskForm, listed: boolean): string {
    if (form.questions.length === 1) {
      return listed
        ? 'Send what you picked, plus anything you typed.'
        : 'Send this answer and let the agent carry on.';
    }
    const blank = blankPages(form);
    if (!blank.length) return 'Send all your answers and let the agent carry on.';
    return (
      `Send all ${form.questions.length} answers. Question${blank.length > 1 ? 's' : ''} ` +
      `${blank.join(', ')} will go back blank, which the agent reads as “nothing to add”.`
    );
  }

  private navButton(
    text: string,
    disabled: boolean,
    title: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = text;
    button.disabled = disabled;
    // A greyed control says why, and here the why is simply where the author is in the form.
    button.title = disabled
      ? text.startsWith('‹')
        ? 'This is the first question.'
        : 'This is the last question.'
      : title;
    button.addEventListener('click', onClick);
    return button;
  }

  /**
   * The way out of a list that does not have the answer on it. It answers rather than dismissing
   * the card, because the turn is parked on this reply and a card closed without one would hang.
   * What it sends is the author's own position, and the transcript shows it as theirs.
   *
   * On a form it fills in every question the author left unanswered and leaves the answered ones
   * alone, since declining to pick can be meant about some of a form and not the rest.
   */
  private chatButton(form: AskForm): HTMLButtonElement {
    const chat = document.createElement('button');
    chat.className = 'btn';
    chat.textContent = 'Chat about this';
    chat.title =
      form.questions.length > 1
        ? 'Answer every question you have left blank with “let us talk it through” and send.'
        : 'Answer that you would rather talk it through than pick from the list.';
    chat.addEventListener('click', () => {
      const said = 'None of those — let us talk it through before I pick.';
      this.sendAnswers(answersOf(this.askForm ?? form).map((a) => (a === '' ? said : a)));
    });
    return chat;
  }

  /** What Answer → and Submit answers send: every page's picks, then what was typed. */
  private reply(): void {
    if (this.askForm) this.sendAnswers(answersOf(this.askForm));
  }

  private sendAnswers(answers: string[]): void {
    this.askForm = null;
    this.askCardEl = null;
    this.askCardRequest = null;
    this.askCardForm = null;
    answer(answers);
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
    acts.appendChild(
      this.allowBtn(
        'Deny',
        'btn',
        false,
        `Refuse ${request.tool}. The agent is told and carries on.`,
      ),
    );
    acts.appendChild(
      this.allowBtn('Allow →', 'btn primary', true, `Let ${request.tool} go ahead, this once.`),
    );
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  private allowBtn(label: string, className: string, allowed: boolean, tip: string): HTMLElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.title = tip;
    button.addEventListener('click', () => allow(allowed));
    return button;
  }
}

/** A token count at a glance: `842`, `12.3k`, `1.4M`. The exact figures are in the tooltip. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

registerEditor(ConvoEditor, 'vn.ConvoEditor');
