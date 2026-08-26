import { CHAT_CSS, ChatStage, el, turnRow } from '../chatsurface.js';
import { VnEditor, registerEditor } from '../editor.js';
import { check, exec, report } from '../bridge.js';
import { effortRows, modelRows } from '../report.js';
import { openReportPreview } from '../reportpreview.js';
import {
  reportConvo,
  reportRevision,
  sayToReport,
  setSetup,
  startReport,
  threadRow,
} from '../reportconvo.js';
import { grantBox } from '../../rules/reportconvo.js';
import type { FiledReport, ReportConvo } from '../../rules/reportconvo.js';
import type { ChoiceRow } from '../commandform.js';
import type { CommandCheck } from '../../../src/shared/ipc.js';

/**
 * The debug agent's pane: the setup card, the transcript, the composer, and a card per report it
 * files. Draws with `chatsurface.ts`, the same parts vnauthor's pane draws with.
 *
 * The setup card is here rather than on a command dialog because the conversation continues after
 * the first answer: a dialog would have to close on the first report, and the second question would
 * have nowhere to go. Its Start button still invokes `report.open`, so the palette and CDP reach the
 * analysis the same way this does.
 *
 * A question the analyst asks is drawn by vnauthor's pane rather than this one. `permission:ask` is
 * one channel shared by both agents and carries no origin, so there is nothing here to tell them
 * apart yet.
 */
const REPORT_CSS = `
.cv-surface .setup { display: flex; flex-direction: column; gap: 10px; }
.cv-surface .setup-row { display: flex; align-items: center; gap: 10px; }
.cv-surface .setup-row > span {
  width: 88px;
  color: var(--mist-dim);
  font-size: 12.5px;
  letter-spacing: 0.04em;
}
.cv-surface .setup select {
  flex: 1;
  min-width: 0;
  background: var(--ink-sunken);
  border: 1px solid var(--ink-line);
  border-radius: var(--r-soft);
  color: var(--paper);
  font: inherit;
  font-size: 13.5px;
  padding: 7px 10px;
}
.cv-surface .setup select:focus { outline: none; border-color: var(--sodium); }
.cv-surface .setup-check {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  color: var(--mist);
  font-size: 13px;
  cursor: pointer;
}
.cv-surface .setup-check input { margin-top: 3px; cursor: pointer; }
.cv-surface .setup-check input:disabled { cursor: default; }
.cv-surface .setup-check.spent { color: var(--mist-dim); cursor: default; }
.cv-surface .setup.grants { margin-top: 12px; }
/* Sodium, the warm this shell keeps for the author's own turn: the pane opened by itself and this
   is the sentence saying why. */
.cv-surface .setup-note { color: var(--sodium); font-size: 13px; }
.cv-surface .filed-where { color: var(--mist-dim); font-size: 12.5px; margin-top: 8px; }
`;

/** One of the two accesses `report.grant` hands over. */
type GrantKind = keyof ReportConvo['granted'];

// What each access buys, worded once: the setup card offers the two before the conversation starts
// and the opened card offers the same two after it has, and a reader who ticks one late should read
// the sentence they read early.
const SOURCE_TIP =
  "The debug agent reads this app's own code and design docs, so it can point at the rule that was " +
  'broken instead of guessing from the conversation. Slower, and it spends more of your tokens.';
const DETAIL_TIP =
  'When the API rejected a request by position — "messages.1.content.0" — only the request itself ' +
  'says what was at that position. They stay on this machine: they are read on your own key and ' +
  'none of what it finds there goes into the report.';

export class ReportEditor extends VnEditor {
  private surface!: HTMLDivElement;
  private transcript!: HTMLDivElement;
  private stage!: ChatStage;
  private drawn = -1;
  /** `report.open`'s own verdict on what the setup card holds, for the Start button's tooltip. */
  private verdict?: CommandCheck;
  /** The setup the verdict was asked about, so a stale answer is dropped rather than drawn. */
  private checkedKey = '';
  /** `report.grant`'s own verdict on each access, for the two boxes on the opened card. */
  private grants: Partial<Record<GrantKind, CommandCheck>> = {};
  /** The conversation and grants the two verdicts were asked about. */
  private grantKey = '';
  /** Whether the setup card is up while a conversation is already open. */
  private changing = false;

  static override define() {
    return {
      tagname: 'vn-report-editor-x',
      areaname: 'report',
      icon: -1,
    };
  }

  override init() {
    super.init();

    this.adoptStyle(CHAT_CSS + REPORT_CSS);
    this.surface = el('div', 'convo cv-surface') as HTMLDivElement;
    this.transcript = el('div', 'transcript') as HTMLDivElement;
    this.surface.appendChild(this.transcript);

    this.stage = new ChatStage({
      nameplate: 'DEBUG AGENT',
      placeholder: 'Tell the debug agent what you had wanted the agent to do…',
      inputTitle:
        'Say what went wrong, or answer what the debug agent asked. Enter sends it. It runs on ' +
        'your own model key, and names from your story are replaced before it sees them.',
      sendTitle: 'Send what is in the box to the debug agent',
      stopTitle: 'Stop the debug agent after the step it is on. What it said is kept.',
      onSend: (text) => void sayToReport(text),
      onStop: () => void exec('report.stop').then(report),
    });
    this.surface.appendChild(this.stage.root);
    this.appendSurface(this.surface);

    // A pane opened part way through, or reopened from a saved layout, has missed every row so far.
    void exec('report.state');
    this.rebuild();
  }

  override update() {
    super.update();
    if (reportRevision() !== this.drawn) this.rebuild();
  }

  private rebuild(): void {
    this.drawn = reportRevision();
    const state = reportConvo();

    this.stage.say(state.convo.line);
    this.stage.setBusy(state.convo.busy);
    this.stage.setChips(state.convo.suggestions);

    const key = JSON.stringify(state.setup);
    if (key !== this.checkedKey) {
      this.checkedKey = key;
      this.verdict = undefined;
      void this.recheck(key);
    }

    const grantKey = JSON.stringify({ thread: state.thread?.id ?? '', granted: state.granted });
    if (grantKey !== this.grantKey) {
      this.grantKey = grantKey;
      this.grants = {};
      void this.regrant(grantKey);
    }

    this.transcript.textContent = '';
    if (!state.thread || this.changing) this.transcript.appendChild(this.setupCard(state));
    else this.transcript.appendChild(this.openedCard(state));

    // A report is filed after a turn rather than in it, so each card is drawn at the feed item it
    // followed. `after: 0` means it arrived before anything was said.
    for (const filed of state.reports)
      if (filed.after === 0) this.transcript.appendChild(this.filedCard(filed));
    for (const item of state.convo.feed) {
      this.transcript.appendChild(turnRow(item));
      for (const filed of state.reports)
        if (filed.after === item.id) this.transcript.appendChild(this.filedCard(filed));
    }

    // The transcript is bottom-aligned, so what just happened is what is on screen.
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  /**
   * Ask `report.open` what it would say to the setup as it stands. The answer is what greys the
   * Start button and what its tooltip reads, so a key that does not resolve is said before the
   * press rather than after it.
   */
  private async recheck(key: string): Promise<void> {
    const verdict = await check('report.open', { ...reportConvo().setup, note: '' });
    if (this.checkedKey !== key) return;
    this.verdict = verdict;
    this.rebuild();
  }

  /**
   * Ask `report.grant` what it would say to each of the two boxes. Both are asked at once, because
   * the boxes are drawn together and a box with no answer yet carries no sentence to show.
   */
  private async regrant(key: string): Promise<void> {
    const [source, detail] = await Promise.all([
      check('report.grant', { access: 'source' }),
      check('report.grant', { access: 'detail' }),
    ]);
    if (this.grantKey !== key) return;
    this.grants = { source, detail };
    this.rebuild();
  }

  // -------------------------------------------------------------------------
  // The setup card
  // -------------------------------------------------------------------------

  private setupCard(state: ReportConvo): HTMLElement {
    const card = el('div', 'plan ask');
    card.appendChild(el('div', 'plan-head', 'READ A CONVERSATION'));

    const body = el('div', 'plan-body');
    if (state.note) body.appendChild(el('div', 'setup-note', state.note));

    const fields = el('div', 'setup');
    fields.appendChild(
      this.pick(
        'conversation',
        state.threads.map((thread) => ({
          value: thread.id,
          ...threadRow(thread),
        })),
        state.setup.thread,
        'Which conversation the debug agent reads. It never leaves this machine.',
        (value) => setSetup({ thread: value }),
      ),
    );
    fields.appendChild(
      this.pick(
        'model',
        modelRows(state.setup.source),
        state.setup.model,
        'Which model reads the conversation. It runs on your own key, so this is what it costs.',
        (value) => setSetup({ model: value }),
      ),
    );
    const efforts = effortRows(state.setup.model);
    if (efforts.length > 0)
      fields.appendChild(
        this.pick(
          'effort',
          efforts,
          state.setup.effort,
          'How hard the model thinks about what went wrong. Higher costs more.',
          (value) => setSetup({ effort: value }),
        ),
      );

    fields.appendChild(
      this.tick('Read the source code', state.setup.source, SOURCE_TIP, (on) =>
        setSetup({ source: on }),
      ),
    );
    fields.appendChild(
      this.tick('Read the requests this app sent', state.setup.detail, DETAIL_TIP, (on) =>
        setSetup({ detail: on }),
      ),
    );
    body.appendChild(fields);

    const acts = el('div', 'plan-acts');
    if (this.changing) {
      const back = this.button('Cancel', 'btn', 'Keep reading the conversation already open.');
      back.addEventListener('click', () => {
        this.changing = false;
        this.rebuild();
      });
      acts.appendChild(back);
    }
    acts.appendChild(this.startButton(state));
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  /**
   * Renders the start button and what it would cost. A refusal shows `report.open`'s own
   * sentence, so the reason a greyed button will not run matches the reason the command would
   * have given.
   */
  private startButton(state: ReportConvo): HTMLElement {
    const refused = this.verdict?.state === 'refuse';
    const busy = state.convo.busy;
    const button = this.button(
      this.changing ? 'Read This One →' : 'Start →',
      'btn primary',
      refused
        ? (this.verdict?.message ?? '')
        : busy
          ? 'The debug agent is still on the last turn.'
          : this.verdict?.state === 'accept'
            ? this.verdict.message
            : 'Have the debug agent read this conversation and say what went wrong.',
    );
    (button as HTMLButtonElement).disabled = refused || busy;
    button.addEventListener('click', () => {
      void startReport().then((view) => {
        if (view) this.changing = false;
      });
    });
    return button;
  }

  /** What is being read, once it is being read. The card the setup card collapses into. */
  private openedCard(state: ReportConvo): HTMLElement {
    const card = el('div', 'plan');
    card.appendChild(el('div', 'plan-head', 'READING'));

    const body = el('div', 'plan-body');
    body.appendChild(el('div', 'plan-sum', state.thread?.title ?? ''));
    body.appendChild(el('div', 'filed-where', `${state.setup.model} is reading it.`));

    // The same two boxes the setup card offers, still offered part way through. A tick lands on the
    // next message rather than on the turn in flight, so ticking one while the debug agent is
    // answering is accepted.
    const fields = el('div', 'setup grants');
    fields.appendChild(this.drawGrant('source', 'Read the source code', SOURCE_TIP));
    fields.appendChild(this.drawGrant('detail', 'Read the requests this app sent', DETAIL_TIP));
    body.appendChild(fields);

    const acts = el('div', 'plan-acts');
    const another = this.button(
      'Read a Different Conversation…',
      'btn',
      state.convo.busy
        ? 'The debug agent is still on the last turn.'
        : 'Put this conversation down and pick another. What was said here stays on screen.',
    );
    (another as HTMLButtonElement).disabled = state.convo.busy;
    another.addEventListener('click', () => {
      this.changing = true;
      this.rebuild();
    });
    acts.appendChild(another);
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  /** A report the analyst filed, as a card in the transcript. */
  private filedCard(filed: FiledReport): HTMLElement {
    const card = el('div', 'plan');
    card.appendChild(el('div', 'plan-head', 'REPORT'));

    const body = el('div', 'plan-body');
    body.appendChild(el('div', 'plan-sum', filed.title));
    if (filed.file) body.appendChild(el('div', 'filed-where', `A copy is kept at ${filed.file}.`));

    const acts = el('div', 'plan-acts');
    const open = this.button(
      'Read It →',
      'btn primary',
      'Read the report over, edit anything you would rather not publish, and file it if you want to.',
    );
    open.addEventListener('click', () =>
      openReportPreview({
        title: filed.title,
        body: filed.body,
        ...(filed.file === undefined ? {} : { file: filed.file }),
      }),
    );
    acts.appendChild(open);
    body.appendChild(acts);

    card.appendChild(body);
    return card;
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  private pick(
    label: string,
    rows: readonly ChoiceRow[],
    value: string,
    tip: string,
    onPick: (value: string) => void,
  ): HTMLElement {
    const row = el('div', 'setup-row');
    row.appendChild(el('span', '', label));

    const select = document.createElement('select');
    select.title = tip;
    for (const choice of rows) {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      // A tooltip per row, so what a choice costs is readable before it is made. Only Chromium
      // draws it, which is the one browser this app runs in.
      if (choice.tooltip) option.title = choice.tooltip;
      select.appendChild(option);
    }
    select.value = value;
    select.addEventListener('change', () => onPick(select.value));
    row.appendChild(select);
    return row;
  }

  /** One access the open conversation can still be given, drawn as `grantBox` decided it. */
  private drawGrant(kind: GrantKind, label: string, offer: string): HTMLElement {
    const box = grantBox(reportConvo().granted[kind], this.grants[kind], offer);

    const row = el('label', box.disabled ? 'setup-check spent' : 'setup-check');
    row.title = box.tooltip;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = box.checked;
    input.disabled = box.disabled;
    input.title = box.tooltip;
    input.addEventListener('change', () => {
      // Disabled before the answer lands, because a second press could only ask for what the first
      // press already asked for.
      input.disabled = true;
      void exec('report.grant', { access: kind }).then(report);
    });

    row.appendChild(input);
    row.appendChild(el('span', '', label));
    return row;
  }

  private tick(
    label: string,
    on: boolean,
    tip: string,
    onTick: (on: boolean) => void,
  ): HTMLElement {
    const row = el('label', 'setup-check');
    row.title = tip;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on;
    box.title = tip;
    box.addEventListener('change', () => onTick(box.checked));
    row.appendChild(box);
    row.appendChild(el('span', '', label));
    return row;
  }

  private button(label: string, className: string, tip: string): HTMLElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.title = tip;
    return button;
  }
}

registerEditor(ReportEditor, 'vn.ReportEditor');
