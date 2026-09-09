import { loadConfig, resolveKeys, secretDirsFor, type ProjectConfig } from '@vn/config';
import { captureSnapshot, chatVendorFor } from '@vn/providers';
import { createRegistry, type AgentEvent } from '@vn/authoring';
import type { EffortChoice } from '@vn/types';
import { EFFORT_CHOICES, resolveEffort } from '@vn/types';
import {
  PASTE_BODY,
  assertIssueUrl,
  createAnalyst,
  issueUrl,
  openingMessage,
  renderReport,
  reportTitle,
  sourceRoot,
  type AnalystGrant,
  type Redactor,
} from '@vn/agentreport';
import { BUSY_REPORT } from '../../shared/ipc.js';
import type { ReportRow, ReportStateView } from '../../shared/ipc.js';
import { type ThreadHeader } from '../notify/threads.js';
import { adviseRun, analysisEffort } from '../../shared/advice.js';
import {
  NO_SOURCE,
  analyseThread,
  analysisParts,
  detailGrant,
  makeRedactor,
  openTranscript,
  saveReport,
  sourceGrant,
  type AnalysisRequest,
  type Transcript,
} from '../agent/agentreport.js';
import type {
  WorkspaceSession,
  PromptResult,
  ReportAsk,
  ReportDraft,
  IssueOpened,
} from './core.js';
import { NO_REPORT, leakSentence, loadProject } from './core.js';

export class ReportPart {
  constructor(private readonly session: WorkspaceSession) {}

  private analysisBinding(
    config: ProjectConfig,
    ask: ReportAsk,
  ): { modelId: string; effort?: EffortChoice } {
    const modelId = ask.model.trim() || this.session.model || config.models.text;
    const asked = ask.effort.trim();
    const chosen = (EFFORT_CHOICES as readonly string[]).includes(asked)
      ? (asked as EffortChoice)
      : undefined;
    const effort = chosen
      ? resolveEffort(modelId, chosen)
      : analysisEffort(modelId, this.session.effort);
    return { modelId, ...(effort ? { effort } : {}) };
  }

  /** The conversation an analysis would read. The one named, or the newest when none is named. */
  private async reportTarget(
    ask: ReportAsk,
  ): Promise<{ ok: false; message: string } | { ok: true; header: ThreadHeader }> {
    const { threads } = await this.session.threads();
    const newest = threads[0];
    if (!newest) {
      return { ok: false, message: 'No conversations have been recorded in this project yet.' };
    }
    const wanted = ask.thread.trim() || newest.id;
    const header = threads.find((t) => t.id === wanted);
    return header ? { ok: true, header } : { ok: false, message: `No conversation ${wanted}.` };
  }

  /**
   * What `report.agent` would do, without spending anything on it. Every refusal is a sentence a
   * disabled control shows verbatim, and the key one is keyed to the chosen model — switching
   * the dropdown from a Claude id to a Gemini one changes which key has to be there. It names the
   * vendor and the command that sets it, never a value.
   */
  async previewReport(ask: ReportAsk): Promise<PromptResult> {
    if (this.session.mock) {
      return {
        ok     : false,
        message:
          'Not while this workspace is running with mock providers — a real model has to read ' +
          'the conversation.',
      };
    }

    const target = await this.reportTarget(ask);
    if (!target.ok) return target;

    const config = await loadConfig(this.session.dir);
    const { modelId, effort } = this.analysisBinding(config, ask);
    const vendor = chatVendorFor(modelId);
    const keys = await resolveKeys(config, { secretsDirs: await secretDirsFor(this.session.dir) });
    if (!keys[vendor]?.trim()) {
      return { ok: false, message: `No ${vendor} key is set — use Provide Model Key… first.` };
    }

    if (ask.source && !(await sourceRoot())) return { ok: false, message: NO_SOURCE };
    // Said before it is run rather than discovered afterwards: with nothing captured the box is
    // ticked for no benefit, and an analyst told it can read requests that do not exist wastes
    // turns finding that out.
    if (ask.detail && captureSnapshot().headers().length === 0) {
      return {
        ok     : false,
        message:
          'Nothing was sent to the model API in this session, so there are no requests to read. ' +
          'Untick reading the requests.',
      };
    }

    const advice = adviseRun(
      modelId,
      effort ?? this.session.effort,
      ask.source,
      this.session.effort,
    );
    const also = ask.detail ? ' It also reads the requests this session sent.' : '';
    return {
      ok     : true,
      message: `Reads “${target.header.title}” with ${modelId}.${advice ? ` ${advice}` : ''}${also}`,
    };
  }

  /**
   * The tools the agent under report could call. Read off the live agent when this window has run
   * a turn, since a host may add to the registry; otherwise from the same default `ensureAgent`
   * builds one from, because a reopened thread can be reported without a turn ever running here.
   */
  private agentTools(): { name: string; description: string }[] {
    if (this.session.agent) return this.session.agent.tools;
    return [...createRegistry().values()].map((t) => ({
      name       : t.name,
      description: t.description,
    }));
  }

  /**
   * Analyse a conversation that went wrong. Long — a minute or two, more with the source — so it
   * takes the busy flag every other long act does, and the dialog closes rather than being held
   * open across it.
   */
  async reportAgent(ask: ReportAsk): Promise<ReportDraft> {
    const { req } = await this.analysisRequest(ask);
    return this.session.while(BUSY_REPORT, async () => {
      const { report, evidence, redactor } = await analyseThread(req);
      this.session.redaction = redactor;
      const body = renderReport(report, evidence);
      return { report, title: reportTitle(report), body, ...(await this.keepReport(body)) };
    });
  }

  /**
   * Everything an analysis is asked for, resolved: which conversation, which model, which key.
   * Shared by the one-shot report and the conversation, so neither can read a different thread or
   * resolve a key the other would not have found.
   */
  private async analysisRequest(
    ask: ReportAsk,
  ): Promise<{ req: AnalysisRequest; header: ThreadHeader }> {
    const target = await this.reportTarget(ask);
    if (!target.ok) throw new Error(target.message);

    const project = await loadProject(this.session.dir);
    const { modelId, effort } = this.analysisBinding(project.config, ask);
    const keys = await resolveKeys(project.config, {
      secretsDirs: await secretDirsFor(this.session.dir),
      require    : [chatVendorFor(modelId)],
    });

    return {
      header: target.header,
      req: {
        dir   : this.session.dir,
        paths : project.paths,
        config: project.config,
        model : project.model,
        keys,
        threadId: target.header.id,
        modelId,
        source       : ask.source,
        reportedTools: this.agentTools(),
        ...(ask.detail ? { detail: true } : {}),
        ...(effort ? { effort } : {}),
        ...(ask.note.trim() ? { wanted: ask.note } : {}),
        ...(this.session.deps.appVersion ? { appVersion: this.session.deps.appVersion } : {}),
        ...(this.session.deps.userData ? { userData: this.session.deps.userData } : {}),
      },
    };
  }

  /**
   * Start a debug conversation about one thread and run its opening turn. Whatever was open is
   * dropped: there is one analyst per app instance, so every window that opens the pane follows
   * the same transcript rather than starting a second analysis of the same thread.
   */
  async openReport(ask: ReportAsk): Promise<ReportStateView> {
    const { req, header } = await this.analysisRequest(ask);
    const parts = await analysisParts(req);
    this.session.analysis = { req, parts, thread: header };
    this.session.reportRows = [];
    this.session.reportGrants = { source: req.source, detail: req.detail === true };
    this.session.transcript = await this.beginTranscript(req, header.id);
    this.session.redaction = parts.redactor;
    this.session.analyst = createAnalyst({
      ...parts.options,
      host: {
        ask    : (form) => this.session.deps.requestAnswer([...form]),
        onEvent: (event) => this.showReport(event),
      },
    });
    // The evidence is the opening message rather than a row, because the pane draws the setup card
    // in its place — the author has not said anything yet
    await this.reportTurn(openingMessage(parts.options));
    return this.session.reportState();
  }

  /**
   * Start writing this conversation down, or carry on without one. A transcript is for reading back
   * later, so failing to open one is not a reason to refuse an analysis the author is waiting on.
   *
   * The conversation's id is written rather than its title, because a title is the author's own
   * words and nothing outside the redacted evidence has been through the redactor.
   */
  private async beginTranscript(
    req: AnalysisRequest,
    thread: string,
  ): Promise<Transcript | undefined> {
    try {
      const transcript = await openTranscript();
      transcript.write({
        kind: 'opened',
        thread,
        model : req.modelId,
        source: req.source,
        detail: req.detail === true,
        ...(req.effort ? { effort: req.effort } : {}),
      });
      return transcript;
    } catch {
      return undefined;
    }
  }

  /** Add one row to the conversation, and to the file it is being written down in. */
  private recordReport(row: ReportRow): void {
    this.session.reportRows.push(row);
    this.session.transcript?.row(row);
  }

  /** One more message to the open conversation, and the turn it starts. */
  async sayToReport(text: string): Promise<ReportStateView> {
    this.recordReport({ kind: 'said', text });
    await this.reportTurn(text);
    return this.session.reportState();
  }

  /**
   * Run one turn. Each turn takes the busy flag rather than the conversation taking it once, so an
   * open pane does not make the session busy for as long as it sits there.
   *
   * A report filed by the turn is rendered and archived here, on the same terms as the one-shot
   * path: the pane cannot render one itself, and a second report supersedes the first on disk
   * without disturbing the card the first one left in the transcript.
   */
  private reportTurn(text: string): Promise<void> {
    const analyst = this.session.analyst;
    if (!analyst) throw new Error(NO_REPORT);
    const evidence = this.session.analysis?.parts.evidence;
    return this.session.while(BUSY_REPORT, async () => {
      const turn = await analyst.ask(text);
      if (!turn.report || !evidence) return;
      const body = renderReport(turn.report, evidence);
      this.recordReport({
        kind  : 'filed',
        report: turn.report,
        title : reportTitle(turn.report),
        body,
        ...(await this.keepReport(body)),
      });
    });
  }

  /**
   * Record one event of the turn in flight and push it to every window. It arrives redacted, so
   * what is kept and what is shown carry pseudonyms the same way the finished report does.
   */
  private showReport(event: AgentEvent): void {
    this.recordReport({ kind: 'event', event });
    if (event.type === 'tool') {
      this.session.progress = { ran: this.session.progress.ran + 1, pending: 0 };
      this.session.announceBusy();
    }
    this.session.deps.emitReport(event);
  }

  /**
   * What granting one kind of access would do, without doing it. Each refusal is a sentence a
   * ticked-and-disabled box shows verbatim. The requests are counted off the snapshot the analysis
   * froze rather than off the live ring, because that is what a grant would actually hand over.
   */
  async previewGrant(kind: AnalystGrant['kind']): Promise<PromptResult> {
    const open = this.session.analysis;
    if (!open || !this.session.analyst) return { ok: false, message: NO_REPORT };
    if (this.session.reportGrants[kind]) {
      return {
        ok     : false,
        message:
          kind === 'source'
            ? 'The debug agent has already been shown the source.'
            : 'The debug agent has already been shown the requests.',
      };
    }
    if (kind === 'source' && !(await sourceRoot())) return { ok: false, message: NO_SOURCE };
    if (kind === 'detail' && open.parts.snapshot.headers().length === 0) {
      return {
        ok     : false,
        message:
          'Nothing was sent to the model API in this session, so there are no requests to read.',
      };
    }
    return {
      ok     : true,
      message:
        kind === 'source'
          ? 'The debug agent gets the source with your next message.'
          : 'The debug agent gets the requests with your next message.',
    };
  }

  /**
   * Give the open conversation more to read. The tools are advertised from the next turn, so this
   * is accepted while a turn is in flight and lands behind it.
   */
  async grantReport(kind: AnalystGrant['kind']): Promise<ReportStateView> {
    const open = this.session.analysis;
    if (!open || !this.session.analyst) throw new Error(NO_REPORT);
    this.session.analyst.grant(
      kind === 'source' ? await sourceGrant(open.req, open.parts.budget) : detailGrant(open.parts),
    );
    this.session.reportGrants[kind] = true;
    this.session.transcript?.write({ kind: 'granted', access: kind });
    return this.session.reportState();
  }

  /**
   * The conversation as main holds it. A pane that mounts part way through asks for this and
   * reduces the rows the way it reduces live events, so there is one reducer rather than a second
   * read path that can disagree with it.
   */
  reportState(): ReportStateView {
    const open = this.session.analysis;
    return {
      ...(open ? { thread: { id: open.thread.id, title: open.thread.title } } : {}),
      busy   : this.session.running(BUSY_REPORT),
      granted: { ...this.session.reportGrants },
      rows   : [...this.session.reportRows],
    };
  }

  /**
   * Archive the report, and report no file when that fails. The author has the analysis on screen
   * either way, and a copy they did not ask for is not worth withholding the analysis they paid a
   * minute and a model call for.
   */
  private async keepReport(body: string): Promise<{ file?: string }> {
    const userData = this.session.deps.userData;
    if (!userData) return {};
    try {
      return { file: await saveReport(userData, body, new Date()) };
    } catch {
      return {};
    }
  }

  /**
   * The redactor used to scan a report body. Normally this is the cached one left behind by the
   * analysis that wrote the report; when no analysis ran in this process (a scripted
   * `report.openIssue(body='…')`), one is built fresh from the current project. Building one
   * costs a full project load, so the result is cached rather than rebuilt on every preview
   * keystroke.
   */
  private async reportRedaction(): Promise<Redactor> {
    if (!this.session.redaction) {
      const project = await loadProject(this.session.dir);
      this.session.redaction = makeRedactor(this.session.dir, project.model);
    }
    return this.session.redaction;
  }

  /**
   * What `report.openIssue` would do. Refuses if the leak scan finds any name the redactor knows
   * still in the body — that name would otherwise end up in a public issue tracker — and the
   * refusal message names it so the author can find it rather than hunt for it.
   */
  async previewIssue(input: { title: string; body: string }): Promise<PromptResult> {
    if (!input.body.trim()) return { ok: false, message: 'There is no report to file.' };
    if (!input.title.trim()) return { ok: false, message: 'An issue needs a title.' };

    const leaked = (await this.reportRedaction()).leaks(input.body);
    if (leaked.length > 0) return { ok: false, message: leakSentence(leaked) };

    return {
      ok     : true,
      message:
        'Copies the report to your clipboard and opens a new issue in your browser, for you to ' +
        'paste it into. Nothing is posted until you press Create.',
    };
  }

  /**
   * Put the whole report on the clipboard, then open GitHub's new-issue form prefilled with the
   * instruction to paste it. The clipboard write comes first deliberately: the browser is where
   * the author needs the report, and it has to already be in hand by then.
   *
   * The report itself never travels on the URL. A length limit that changed what the author had to
   * do is a limit they had to learn, so the form always says the same thing.
   *
   * The leak scan runs again here rather than trusting `previewIssue`: a caller may skip the
   * check (CDP can call this directly), and the one thing this must never do is publish a name.
   */
  async openIssue(input: { title: string; body: string }): Promise<IssueOpened> {
    const preview = await this.session.previewIssue(input);
    if (!preview.ok) throw new Error(preview.message);

    const open = this.session.deps.openExternal;
    if (!open) throw new Error('This build cannot open a browser.');

    const url = issueUrl({ title: input.title, body: PASTE_BODY });
    // Checks the URL that reaches the shell rather than trusting what `issueUrl` composed
    assertIssueUrl(url);

    this.session.deps.writeClipboard?.(input.body);
    await open(url.href);
    return { url: url.href };
  }

  /**
   * Put `text` on the system clipboard. Throws where the build has no clipboard, so a caller
   * reports the failure rather than claiming a copy that never happened.
   */
  copyText(text: string): void {
    const write = this.session.deps.writeClipboard;
    if (!write) throw new Error('This build has no clipboard.');
    write(text);
  }

  /** Portrait candidates for a character at the approval gate (from the manifest). */
}
