import { Menu, createMenu, startMenu } from 'pathux';
import type { Button, Container, DropBox, Label, MenuTemplate, MenuTemplateCustom } from 'pathux';
import { BUDGET_CHOICES, TEXT_MODELS, budgetLabel, effortChoicesFor, effortLabel } from '@vn/types';
import {
  allow,
  answer,
  ask,
  askFormFor,
  askFormNow,
  convo,
  decide,
  reopenedThread,
  revision,
  setAskForm,
  takeSeed,
} from '../agent.js';
import { api } from '../../api.js';
import { exec, onInvalidate, report, setBudget, setEffort, setMode, setModel } from '../bridge.js';
import {
  AskCards,
  CHAT_CSS,
  ChatStage,
  compact,
  compactionRule,
  el,
  turnRow,
  type AskHost,
} from '../chatsurface.js';
import { VnEditor, registerEditor } from '../editor.js';
import { openPalette } from '../palette.js';
import {
  contextDetail,
  threadDetail,
  threadLabel,
  tokensDetail,
  uncachedTokens,
  type ThreadHeader,
} from '../../../src/shared/convo.js';
import { redrawing, type AnchorPass } from '../anchors.js';
import { modeAction, MODEL_SUPPLIES } from '../../rules/headerbar.js';
import {
  THREAD_SUPPLIES,
  compactAction,
  newThreadAction,
  resumeAction,
  stopTurnAction,
} from '../../rules/convobar.js';
import type { AskForm } from '../../rules/askform.js';
import type { ConfirmRequest, Plan, SkillEntry } from '../../../src/shared/ipc.js';

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
 * already said. What it draws with comes from `chatsurface.ts`, which the debug agent's pane
 * draws with too.
 */
export class ConvoEditor extends VnEditor {
  private bar!: Container;
  private surface!: HTMLDivElement;
  private transcript!: HTMLDivElement;
  private stage!: ChatStage;
  private asks!: AskCards;
  /** Kept because the thread menu opens under it, and only the button knows where that is. */
  private threadsBtn!: Button;
  private anchors: AnchorPass = redrawing('convo', 'bar');
  /**
   * The running token total. Retitled in place rather than keyed into {@link stateKey}: a step
   * finishing would otherwise rebuild the whole bar mid-turn, closing any menu open over it.
   */
  private tokensLbl?: Label;
  /** Retitled and greyed in place, for the reason {@link tokensLbl} is retitled in place. */
  private compactBtn?: Button;
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
  /**
   * The project's skills, for the composer's `/` menu. Held rather than fetched per keystroke, and
   * re-read whenever anything writes: `create_skill` is a turn in this very pane, so a composer
   * that only read them at boot would not offer the skill the author just asked for.
   */
  private skills: readonly SkillEntry[] = [];

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

    this.adoptStyle(CHAT_CSS);
    this.surface = el('div', 'convo cv-surface') as HTMLDivElement;
    this.transcript = el('div', 'transcript') as HTMLDivElement;
    this.surface.appendChild(this.transcript);

    this.stage = new ChatStage({
      nameplate: 'VNAUTHOR',
      placeholder: 'Reply to vnauthor, or ask for a change…',
      inputTitle:
        'Say what you want changed. Enter sends it; the agent answers with a plan. Start the ' +
        'line with / to name one of this project’s skills.',
      sendTitle: 'Send what is in the box to the agent',
      // Through the registry like everything else, so interrupting from here and interrupting
      // from the palette are one act with one record. A turn that ended in the meantime is
      // refused in the command's own words
      stopTitle: 'Stop the agent after the step it is on. What it already did is kept.',
      onSend: (text) => void ask(text),
      onStop: () => {
        const offer = stopTurnAction(convo().busy);
        if (offer.ok) void exec(offer.id, offer.props).then(report);
      },
      // Recorded once with the composer, which outlives every rebuild. The button is hidden between
      // turns, and a hidden node is dropped from the live set, so the anchor comes and goes with it.
      onStopButton: (button) => redrawing('convo', 'composer').record(button, stopTurnAction(true)),
      onPalette: () => openPalette(),
      skills: () => this.skills,
    });
    this.surface.appendChild(this.stage.root);
    this.appendSurface(this.surface);

    this.asks = new AskCards(this.askHost());

    this.watch(
      () => onInvalidate(() => void this.loadSkills()),
      () => void this.loadSkills(),
    );
    void this.loadSkills();

    this.rebuild();
  }

  /** Re-read the skills the `/` menu offers. A project with none simply offers nothing. */
  private async loadSkills(): Promise<void> {
    try {
      this.skills = await api.invoke('workspace:skills');
    } catch {
      // Nothing to say and nothing to break: with no list the composer treats `/` as a character.
      this.skills = [];
    }
  }

  /** The vnauthor side of a question card: the store in `agent.ts`, and this pane's redraw. */
  private askHost(): AskHost {
    return {
      head: 'VNAUTHOR ASKS',
      formFor: (request) => askFormFor(request),
      formNow: () => askFormNow(),
      setForm: (next: AskForm, redraw = true) => setAskForm(next, redraw),
      send: (answers) => answer(answers),
      redraw: () => this.rebuild(),
    };
  }

  override update() {
    super.update();

    if (revision() !== this.drawn) this.rebuild();
    if (this.stateKey() !== this.barKey) this.rebuildBar();
    if (this.budgetSay() !== this.budgetKey) this.sayBudget();
  }

  /**
   * What the bar draws from. Three session facts, none of them the conversation's, plus which saved
   * conversation is on screen for reading — the Continue button exists only while one is.
   */
  private stateKey(): string {
    const ui = this.ui;
    return `${ui.agentMode}|${ui.model}|${ui.effort}|${reopenedThread()?.id ?? ''}`;
  }

  /**
   * The bar the author reads before typing. The header carries the same mode toggle, but this is
   * the pane a turn is entered into, so it is the pane that has to say whether typing edits files.
   */
  private rebuildBar(): void {
    this.barKey = this.stateKey();
    const ui = this.ui;

    this.bar.clear();
    this.anchors = redrawing('convo', 'bar');
    // Row one shows what answered a turn. Row two shows what it cost and where the thread is kept.
    const top = this.bar.row();
    const low = this.bar.row();

    top.label('VNAUTHOR').style['padding'] = '0px 8px';
    const mode = this.anchors.act(
      top.button(ui.agentMode === 'plan' ? 'PLAN' : 'EXECUTE', () => {}),
      modeAction(ui.agentMode),
      (action) => void setMode(String(action.props['mode'] ?? '')),
    );
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
    this.anchors.record(
      model,
      { ok: true, id: 'agent.setModel', props: {} },
      { supplies: MODEL_SUPPLIES },
    );

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

    this.threadsBtn = this.anchors.record(
      low.button('Threads', () => void this.showThreads()),
      { ok: true, id: 'agent.openThread', props: {} },
      { supplies: THREAD_SUPPLIES },
    );
    this.threadsBtn.description =
      'Saved conversations. Reopening one is read-only — the agent is not shown it until ' +
      'Continue hands it back.';

    // This button sits beside the Threads list rather than only inside it. Starting a fresh
    // conversation is the commonest thing anyone opens that menu for, and putting it here makes
    // it one gesture instead of two.
    const fresh = this.anchors.act(
      low.button('New', () => {}),
      newThreadAction(),
      (action) => void exec(action.id, action.props),
    );
    fresh.description =
      'Save this conversation and start a fresh one in plan mode. Nothing is lost — the old one ' +
      'stays under Threads.';

    this.compactBtn = this.anchors.act(
      low.button('Compact', () => {}),
      compactAction(convo(), reopenedThread() !== undefined),
      (action) => void exec(action.id, action.props).then(report),
    );
    this.sayCompact();

    // Drawn only while a saved conversation is on screen, because there is nothing to continue
    // while the live one is.
    const opened = reopenedThread();
    if (opened) {
      const offer = resumeAction(opened, ui.model);
      const cont = this.anchors.act(
        low.button('Continue', () => {}),
        offer,
        (action) => void exec(action.id, action.props).then(report),
      );
      cont.description = offer.ok
        ? 'Continue this conversation — the agent is shown everything above.'
        : offer.reason;
      cont.disabled = !offer.ok;
    }

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
   * Why compacting is refused here, or `undefined`. Three of main's own refusals, restated against
   * what the renderer can see, so the button is greyed with a sentence rather than reporting one a
   * click later. Main's check stays the authority and answers the rest on the click.
   */
  /**
   * The Compact button, retitled in place for the reason the token counter is: what it says changes
   * on every step of a turn, and rebuilding the bar closes a menu open over it. Past
   * `COMPACT_HINT_TOKENS` the tooltip says the conversation is large enough to be worth compacting.
   */
  private sayCompact(): void {
    if (!this.compactBtn) return;
    const state = convo();
    const offer = compactAction(state, reopenedThread() !== undefined);
    this.compactBtn.disabled = !offer.ok;
    this.compactBtn.description = offer.ok ? contextDetail(state) : offer.reason;
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

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private rebuild(): void {
    this.drawn = revision();
    const state = convo();

    this.stage.say(state.line);
    this.sayTokens();
    this.sayCompact();
    this.sayBudget();
    this.stage.setBusy(state.busy);
    this.stage.setChips(state.suggestions);

    // Detaching the reused ask card drops focus to the body even though the node survives, so the
    // caret is restored once the card is back in the document
    const root = this.transcript.getRootNode() as Document | ShadowRoot;
    const active = root.activeElement as HTMLElement | null;
    const refocus = this.asks.holds(active) ? active : null;

    this.transcript.textContent = '';
    if (state.feed.length === 0 && !state.plan && !state.question && !state.confirm) {
      this.transcript.appendChild(
        el('div', 'empty-hint', 'Ask vnauthor to change a character, scene, or location.'),
      );
    }
    // Each rule goes under the line it was drawn after, so the turns a summary covers stay above
    // it. A mark whose line is gone falls through to the end rather than being dropped.
    const marks = [...state.compactions];
    const rulesUpTo = (id: number): void => {
      while (marks.length > 0 && marks[0]!.afterId <= id) {
        this.transcript.appendChild(compactionRule(marks.shift()!));
      }
    };
    rulesUpTo(0);
    for (const item of state.feed) {
      this.transcript.appendChild(turnRow(item));
      rulesUpTo(item.id);
    }
    rulesUpTo(Number.MAX_SAFE_INTEGER);
    if (state.plan) this.transcript.appendChild(this.planCard(state.plan.plan));
    if (state.question) this.transcript.appendChild(this.asks.cardFor(state.question));
    if (state.confirm) this.transcript.appendChild(this.confirmCard(state.confirm));
    // The transcript is bottom-aligned, so what just happened is what is on screen.
    this.transcript.scrollTop = this.transcript.scrollHeight;
    refocus?.focus();

    const seeded = takeSeed();
    if (seeded !== null) this.stage.fill(seeded);
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

registerEditor(ConvoEditor, 'vn.ConvoEditor');
