import type { Button, Container, DropBox, Label, MenuTemplate } from 'pathux';
import { showContextMenu } from '../chrome/showmenu.js';
import type { VnContext } from '../app/context.js';
import { BUDGET_CHOICES, budgetLabel, effortChoicesFor, effortLabel } from '@vn/types';
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
} from '../agent/agent.js';
import { api } from '../../api.js';
import {
  exec,
  onInvalidate,
  report,
  setBudget,
  setEffort,
  setMode,
  setModel,
} from '../app/bridge.js';
import {
  AskCards,
  CHAT_CSS,
  ChatStage,
  compactionRule,
  el,
  turnRow,
  type AskHost,
} from '../agent/chatsurface.js';
import { VnEditor, registerEditor } from '../app/editor.js';
import { openPalette } from '../chrome/palette.js';
import { tokensDetail, uncachedTokens, type ThreadHeader } from '../../../src/shared/convo.js';
import { redrawing, type AnchorPass } from '../tour/anchors.js';
import { modeAction, modelAction } from '../../rules/headerbar.js';
import { textModelMenu } from '../widgets/modelmenu.js';
import {
  decideAction,
  allowAction,
  budgetAction,
  compact,
  compactAction,
  effortAction,
  newThreadAction,
  resumeAction,
  stopTurnAction,
  threadsAction,
  threadsMenu,
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
  /** Re-anchored in place, for the reason {@link tokensLbl} is retitled in place. */
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
      tagname : 'vn-convo-editor-x',
      areaname: 'convo',
      icon    : -1,
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
      nameplate   : 'VNAUTHOR',
      placeholder : 'Reply to vnauthor, or ask for a change…',
      inputTitle:
        'Say what you want changed. Enter sends it; the agent answers with a plan. Start the ' +
        'line with / to name one of this project’s skills.',
      sendTitle   : 'Send what is in the box to the agent',
      // Through the registry like everything else, so interrupting from here and interrupting
      // from the palette are one act with one record. A turn that ended in the meantime is
      // refused in the command's own words
      stopTitle   : 'Stop the agent after the step it is on. What it already did is kept.',
      onSend      : (text) => void ask(text),
      onStop: () => {
        const offer = stopTurnAction(convo().busy);
        if (offer.ok) void exec(offer.id, offer.props).then(report);
      },
      // Recorded once with the composer, which outlives every rebuild. The button is hidden between
      // turns, and a hidden node is dropped from the live set, so the anchor comes and goes with it.
      onStopButton: (button) => redrawing('convo', 'composer').record(button, stopTurnAction(true)),
      onPalette   : () => openPalette(),
      skills      : () => this.skills,
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
      head   : 'VNAUTHOR ASKS',
      formFor: (request) => askFormFor(request),
      formNow: () => askFormNow(),
      setForm: (next: AskForm, redraw = true) => setAskForm(next, redraw),
      send   : (answers) => answer(answers),
      redraw : () => this.rebuild(),
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
    const modeOffer = modeAction(ui.agentMode);
    this.anchors.act(
      top.button(modeOffer.label, () => {}),
      modeOffer,
      (action) => void setMode(String(action.props['mode'] ?? '')),
    );

    const model = modelAction(ui.model);
    this.anchors.record(
      textModelMenu(
        top,
        model.label,
        () => this.ui.model,
        (id) => void setModel(id),
      ),
      model,
    );

    // Rows carry their own tooltip, so the last slot has to be an explicit id: `createMenu` reads
    // `item[5]` for any row longer than four and would otherwise file the callback under undefined.
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
    const effort = effortAction(ui.model, ui.effort);
    this.anchors.record(top.menu(effort.label, efforts), effort);

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
    // Anchored by `sayBudget` rather than by the bar's pass, since the spend moves under it
    this.sayBudget();

    this.tokensLbl = low.label('');
    this.tokensLbl.setCSSAfter(() => (this.tokensLbl!.style['padding'] = '0px 8px'));
    this.sayTokens();

    // The menu picks the conversation, so its id is not a prop the bar can record
    const threads = threadsAction();
    this.threadsBtn = this.anchors.record(
      low.button(threads.label, () => void this.showThreads()),
      threads,
    );

    // This button sits beside the Threads list rather than only inside it. Starting a fresh
    // conversation is the commonest thing anyone opens that menu for, and putting it here makes
    // it one gesture instead of two.
    const fresh = newThreadAction();
    this.anchors.act(
      low.button(fresh.label, () => {}),
      fresh,
      (action) => void exec(action.id, action.props),
    );

    // Anchored by `sayCompact` rather than by the bar's pass, for the reason the budget menu is
    this.compactBtn = low.button(
      compactAction(convo(), reopenedThread() !== undefined).label,
      () => {},
    );
    this.sayCompact();

    // Drawn only while a saved conversation is on screen, because there is nothing to continue
    // while the live one is.
    const opened = reopenedThread();
    if (opened) {
      const offer = resumeAction(opened, ui.model);
      this.anchors.act(
        low.button(offer.label, () => {}),
        offer,
        (action) => void exec(action.id, action.props).then(report),
      );
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
    const offer = budgetAction(this.ui.budget, convo().turnSpend);
    // Through the attribute rather than a field: `updateName` is what notices the change and
    // re-measures the canvas the label is painted on.
    this.budgetMenu.setAttribute('name', offer.label);
    redrawing('convo', 'budget').record(this.budgetMenu, offer);
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
   * The Compact button, re-anchored in place for the reason the token counter is retitled in
   * place: what it offers changes on every step of a turn, and rebuilding the bar closes a menu
   * open over it. Past `COMPACT_HINT_TOKENS` the tooltip says the conversation is large enough to
   * be worth compacting.
   */
  private sayCompact(): void {
    if (!this.compactBtn) return;
    redrawing('convo', 'compact').act(
      this.compactBtn,
      compactAction(convo(), reopenedThread() !== undefined),
      (action) => void exec(action.id, action.props).then(report),
    );
  }

  /** The saved conversations, as the menu table lists them, dropped below the Threads button. */
  private async showThreads(): Promise<void> {
    const outcome = await exec('agent.threads');
    if (!outcome.ok) return;
    const { threads, active } = outcome.data as { threads: ThreadHeader[]; active?: string };
    const rect = this.threadsBtn.getBoundingClientRect();
    await showContextMenu(
      this.ctx as VnContext,
      rect.x,
      rect.y + rect.height,
      'Conversations',
      threadsMenu({ threads, ...(active === undefined ? {} : { active }) }),
    );
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
    this.cardPass = redrawing('convo', 'cards');
    if (state.plan) this.transcript.appendChild(this.planCard(state.plan.plan));
    if (state.question) this.transcript.appendChild(this.asks.cardFor(state.question));
    if (state.confirm) this.transcript.appendChild(this.confirmCard(state.confirm));
    // The transcript is bottom-aligned, so what just happened is what is on screen.
    this.transcript.scrollTop = this.transcript.scrollHeight;
    refocus?.focus();

    const seeded = takeSeed();
    if (seeded !== null) this.stage.fill(seeded);
  }

  /** The cards' own pass, replaced with the transcript, so a redraw drops the old buttons whole. */
  private cardPass: AnchorPass = redrawing('convo', 'cards');

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
    acts.appendChild(this.decideBtn('btn', false));
    acts.appendChild(this.decideBtn('btn primary', true));
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  private decideBtn(className: string, approved: boolean): HTMLElement {
    const offer = decideAction(approved);
    const button = document.createElement('button');
    button.className = className;
    button.textContent = offer.label;
    return this.cardPass.act(button, offer, () => void decide(approved));
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
    acts.appendChild(this.allowBtn('btn', request.tool, false));
    acts.appendChild(this.allowBtn('btn primary', request.tool, true));
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  private allowBtn(className: string, tool: string, allowed: boolean): HTMLElement {
    const offer = allowAction(tool, allowed);
    const button = document.createElement('button');
    button.className = className;
    button.textContent = offer.label;
    return this.cardPass.act(button, offer, () => allow(allowed));
  }
}

registerEditor(ConvoEditor, 'vn.ConvoEditor');
