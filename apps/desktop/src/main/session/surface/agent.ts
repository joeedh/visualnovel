import type { ProjectConfig } from '@vn/config';
import {
  Workspace,
  type Agent,
  type AgentBackend,
  type AgentEvent,
  type AgentMode,
  type ApiFailure,
  type ApiRecovery,
  type GeneratedContextState,
  type GeneratedCounts,
  type HistoryReader,
  type RunResult,
  type UploadBatch,
  type WorkspaceIndex,
} from '@vn/authoring';
import type { Excerpt } from '@vn/bible';
import type { EffortChoice } from '@vn/types';
import type { BudgetChoice, Transport } from '@vn/types';
import type { AnalystGrant } from '@vn/agentreport';
import type { AgentSystem, ReportStateView } from '../../../shared/ipc.js';
import type { CompactionMark } from '../../../shared/convo.js';
import type { ThreadHeader, ThreadRecord } from '../../notify/threads.js';
import type { OpenedThread } from '../../../shared/threads.js';
import type { AgentPart } from '../agent.js';
import type { BackendPart } from '../backend.js';
import type { ReportPart } from '../report.js';
import type { IssueOpened, PromptResult, ReportAsk, ReportDraft } from '../types/results.js';
import { SessionBase } from './base.js';
export abstract class AgentSurface extends SessionBase {
  abstract readonly agentPart: AgentPart;
  abstract readonly backendPart: BackendPart;
  abstract readonly reportPart: ReportPart;

  async ensureAgent(): Promise<Agent> {
    return this.backendPart.ensureAgent();
  }

  async buildBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    return this.backendPart.buildBackend(config, model);
  }

  async chooseBackend(config: ProjectConfig, model?: string): Promise<AgentBackend> {
    return this.backendPart.chooseBackend(config, model);
  }

  async continuingTransport(
    config: ProjectConfig,
    recorded: Transport | undefined,
  ): Promise<Transport | undefined> {
    return this.backendPart.continuingTransport(config, recorded);
  }

  history(): HistoryReader {
    return this.backendPart.history();
  }

  async recoverApi(failure: ApiFailure): Promise<ApiRecovery> {
    return this.backendPart.recoverApi(failure);
  }

  announceApi(event: Extract<AgentEvent, { type: 'api' }>): void {
    return this.backendPart.announceApi(event);
  }

  // ---- IPC-facing methods ----

  index(): Promise<WorkspaceIndex> {
    return this.workspace().index();
  }

  /** The session's one workspace. See {@link heldWorkspace} for what it does and does not reuse. */

  workspace(): Workspace {
    return (this.heldWorkspace ??= new Workspace(this.dir));
  }

  /** Where the agent's generated project map lives, and whether it is ours to replace. */

  generatedContext(): Promise<GeneratedContextState> {
    return this.agentPart.generatedContext();
  }

  writeGeneratedContext(): Promise<{ file: string; counts: GeneratedCounts }> {
    return this.agentPart.writeGeneratedContext();
  }

  /**
   * Ranked passages from the story bible. The index survives between searches on the session's
   * one workspace, and `query` re-walks, so a passage written since the last search is still
   * found.
   */
  async searchBible(query: string, limit?: number): Promise<Excerpt[]> {
    return this.agentPart.searchBible(query, limit);
  }

  /**
   * One turn. `scene` is what the author had on screen when they hit send — resolved here against
   * the project rather than trusted, so a selection that has since been deleted contributes
   * nothing instead of a sentence about a scene that is gone.
   */
  async runAgent(input: string, scene?: string): Promise<RunResult> {
    return this.agentPart.runAgent(input, scene);
  }

  async setMode(mode: AgentMode): Promise<AgentMode> {
    return this.agentPart.setMode(mode);
  }

  /**
   * Hot-swap the text model and rebuild the backend, preserving conversation state. The bound
   * effort is stepped down to what the new model offers — `xhigh` is not a level Sonnet 4.6
   * takes — so nothing downstream shows a setting the wire will not carry.
   */
  async setModel(modelId: string): Promise<string> {
    return this.agentPart.setModel(modelId);
  }

  /**
   * Hot-swaps the reasoning setting the same way. A model that honours none keeps the setting
   * anyway. A surface greys itself out based on `supportsEffort`, and the backend simply omits
   * the knob, so switching back to a model that does honour it needs no second gesture.
   */
  async setEffort(effort: EffortChoice): Promise<EffortChoice> {
    return this.agentPart.setEffort(effort);
  }

  /**
   * The turn ceiling. Nothing is rebuilt and nothing is awaited beyond the agent existing: the
   * budget is read by the loop at each step, so a change lands on the turn in flight too.
   */
  async setBudget(budget: BudgetChoice): Promise<BudgetChoice> {
    return this.agentPart.setBudget(budget);
  }

  /**
   * The system prompt the next turn will carry, in its sections.
   *
   * Assembled from the project rather than read off `this.agent`, and deliberately so: `runAgent`
   * calls `refreshSystem(appSections(await loadContext(...)))` before every turn, so this is
   * exactly what the next turn sends — and it can be answered before an agent has ever been
   * built, which is when an author most wants to check what it was told.
   */
  async systemPrompt(): Promise<AgentSystem> {
    return this.agentPart.systemPrompt();
  }

  /**
   * Start over. The thread is closed rather than deleted — a conversation that happened stays on
   * disk, and the next turn opens a new one — and it is committed on the way out, so that what
   * stays on disk also stays in history.
   */
  /** Why the conversation cannot be closed now, or `undefined`; what `clearAgent` throws. */
  clearRefusal(): string | undefined {
    return this.agentPart.clearRefusal();
  }

  async clearAgent(): Promise<void> {
    return this.agentPart.clearAgent();
  }

  /**
   * Copy the author's own documents into `archive/`, verbatim. The rule lives in `@vn/authoring`
   * so the REPL's `/upload` and this land in the same place; the session only supplies the root.
   */
  async uploadFiles(files: string[]): Promise<UploadBatch> {
    return this.agentPart.uploadFiles(files);
  }

  /** Tell the model something ahead of the author's next turn. */
  async noteAgentContext(text: string): Promise<void> {
    return this.agentPart.noteAgentContext(text);
  }

  async threads(): Promise<{ threads: ThreadHeader[]; active?: string }> {
    return this.agentPart.threads();
  }

  /**
   * A saved conversation, for reading. It ends the live one: the model is never shown what comes
   * back, so leaving the previous turns in its context while the screen shows another
   * conversation would leave the author and the agent talking about different things.
   */
  async openThreadForReading(id: string): Promise<OpenedThread> {
    return this.agentPart.openThreadForReading(id);
  }

  /**
   * Why thread `id` cannot be continued on the binding in force, or `undefined`. What
   * `agent.resumeThread` refuses with, and what its menu entry is greyed with.
   *
   * The agent is built first because building the backend is what settles which protocol it speaks
   * and which model it is bound to, and both are what the stored conversation is checked against.
   */
  async resumeRefusalFor(id: string): Promise<string | undefined> {
    return this.agentPart.resumeRefusalFor(id);
  }

  /**
   * Continue a saved conversation: hand the agent the messages it was recorded with, then bind the
   * session to the thread they came from so later turns append to the same two files.
   *
   * Continuing happens on the model bound now rather than the one the conversation was recorded
   * with. `setModel` already promises a mid-conversation swap keeps the transcript, and the check
   * above has already refused a swap the stored messages could not survive.
   */
  async resumeThread(id: string): Promise<ThreadRecord> {
    return this.agentPart.resumeThread(id);
  }

  /**
   * Why the open conversation cannot be compacted, or `undefined`. What `agent.compact` refuses
   * with, and what its button is greyed with.
   *
   * The third case is the one worth naming: a turn that ended part way through a tool call cannot
   * be compacted, because the summary would cover messages the agent is still holding, and the
   * live conversation and the log would then disagree about what has been replaced.
   */
  async compactRefusalFor(): Promise<string | undefined> {
    return this.agentPart.compactRefusalFor();
  }

  /**
   * Compact the open conversation: summarize everything said so far on the model the conversation
   * is bound to, hand the agent the summary in place of the messages, and append both records.
   *
   * Nothing is rewritten. The summary is one more line in each log, so the transcript on screen is
   * unchanged and a later resume reads the summary plus whatever was said after it. The read
   * ledger goes with the messages, which `compactionMessage` tells the agent about.
   */
  async compactThread(): Promise<CompactionMark> {
    return this.agentPart.compactThread();
  }

  async renameThread(id: string, title: string): Promise<ThreadHeader> {
    return this.agentPart.renameThread(id, title);
  }

  /**
   * What `report.agent` would do, without spending anything on it. Every refusal is a sentence a
   * disabled control shows verbatim, and the key one is keyed to the chosen model — switching
   * the dropdown from a Claude id to a Gemini one changes which key has to be there. It names the
   * vendor and the command that sets it, never a value.
   */
  async previewReport(ask: ReportAsk): Promise<PromptResult> {
    return this.reportPart.previewReport(ask);
  }

  /**
   * Analyse a conversation that went wrong. Long — a minute or two, more with the source — so it
   * takes the busy flag every other long act does, and the dialog closes rather than being held
   * open across it.
   */
  async reportAgent(ask: ReportAsk): Promise<ReportDraft> {
    return this.reportPart.reportAgent(ask);
  }

  /**
   * Start a debug conversation about one thread and run its opening turn. Whatever was open is
   * dropped: there is one analyst per app instance, so every window that opens the pane follows
   * the same transcript rather than starting a second analysis of the same thread.
   */
  async openReport(ask: ReportAsk): Promise<ReportStateView> {
    return this.reportPart.openReport(ask);
  }

  async sayToReport(text: string): Promise<ReportStateView> {
    return this.reportPart.sayToReport(text);
  }

  /**
   * What granting one kind of access would do, without doing it. Each refusal is a sentence a
   * ticked-and-disabled box shows verbatim. The requests are counted off the snapshot the analysis
   * froze rather than off the live ring, because that is what a grant would actually hand over.
   */
  async previewGrant(kind: AnalystGrant['kind']): Promise<PromptResult> {
    return this.reportPart.previewGrant(kind);
  }

  /**
   * Give the open conversation more to read. The tools are advertised from the next turn, so this
   * is accepted while a turn is in flight and lands behind it.
   */
  async grantReport(kind: AnalystGrant['kind']): Promise<ReportStateView> {
    return this.reportPart.grantReport(kind);
  }

  /**
   * The conversation as main holds it. A pane that mounts part way through asks for this and
   * reduces the rows the way it reduces live events, so there is one reducer rather than a second
   * read path that can disagree with it.
   */
  reportState(): ReportStateView {
    return this.reportPart.reportState();
  }

  /**
   * What `report.openIssue` would do. Refuses if the leak scan finds any name the redactor knows
   * still in the body — that name would otherwise end up in a public issue tracker — and the
   * refusal message names it so the author can find it rather than hunt for it.
   */
  async previewIssue(input: { title: string; body: string }): Promise<PromptResult> {
    return this.reportPart.previewIssue(input);
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
    return this.reportPart.openIssue(input);
  }

  /**
   * Put `text` on the system clipboard. Throws where the build has no clipboard, so a caller
   * reports the failure rather than claiming a copy that never happened.
   */
  copyText(text: string): void {
    return this.reportPart.copyText(text);
  }
}
