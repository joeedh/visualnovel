import { loadConfig } from '@vn/config';
import { openGit } from '@vn/git';
import { ProjectPaths } from '@vn/store';
import { exists } from '@vn/util';
import {
  COMPACTION_SYSTEM,
  Workspace,
  archiveUpload,
  compactRange,
  compactionPrompt,
  lastCompleteTurn,
  focusOnScene,
  loadContext,
  restorable,
  type AgentEvent,
  type AgentMode,
  type GeneratedContextState,
  type GeneratedCounts,
  type RunResult,
  type SectionDelta,
  type SystemSection,
  type UploadBatch,
} from '@vn/authoring';
import type { Excerpt } from '@vn/bible';
import type { EffortChoice } from '@vn/types';
import { EFFORT_CHOICES, resolveEffort, type BudgetChoice } from '@vn/types';
import { appSections } from '../agent/showme.js';
import { BUSY_AGENT } from '../../shared/ipc.js';
import type { AgentSystem } from '../../shared/ipc.js';
import {
  answered,
  asked,
  compacted,
  emptyConvo,
  received,
  replayed,
  type CompactionMark,
} from '../../shared/convo.js';
import {
  ConflictedLogError,
  appendCompaction,
  archiveThread,
  bindThread,
  listThreads,
  liveMessages,
  nativeFile,
  openThread,
  readNative,
  readThread,
  retitleThread,
  threadFile,
  titleFrom,
  type NativeLog,
  type ThreadHeader,
  type ThreadRecord,
} from '../notify/threads.js';
import {
  headerTransport,
  resumeRefusal,
  type OpenedThread,
  type ResumeBinding,
  type ResumeState,
} from '../../shared/threads.js';
import type { WorkspaceSession } from './core.js';
import { wroteAuthoredInput, resumedNote } from './core.js';

export class AgentPart {
  constructor(private readonly session: WorkspaceSession) {}

  generatedContext(): Promise<GeneratedContextState> {
    return new Workspace(this.session.dir).generatedContext();
  }

  /** Rebuild the generated project map. Throws if a file already sits at the path and the
   * generator did not write it. */
  writeGeneratedContext(): Promise<{ file: string; counts: GeneratedCounts }> {
    return new Workspace(this.session.dir).writeGeneratedContext();
  }

  /**
   * Rewrite the map if a turn made it stale, before the next turn is composed. It never throws:
   * if the file at that path was not written by the generator it is somebody's own note, and the
   * right response is to leave it alone and log a warning — not to fail the turn the map was
   * about to help.
   */
  private async refreshProjectMap(): Promise<void> {
    if (!this.session.mapStale) return;
    this.session.mapStale = false;
    try {
      await this.session.writeGeneratedContext();
    } catch (err) {
      console.warn(`[vnstudio] could not rewrite the project map: ${String(err)}`);
    }
  }

  /**
   * Ranked passages from the story bible. The index survives between searches on the session's
   * one workspace, and `query` re-walks, so a passage written since the last search is still
   * found.
   */
  async searchBible(query: string, limit?: number): Promise<Excerpt[]> {
    const bible = await this.session.workspace().bible();
    return bible.query(query, limit === undefined ? {} : { limit });
  }

  /**
   * One turn. `scene` is what the author had on screen when they hit send — resolved here against
   * the project rather than trusted, so a selection that has since been deleted contributes
   * nothing instead of a sentence about a scene that is gone.
   */
  async runAgent(input: string, scene?: string): Promise<RunResult> {
    return this.session.while(BUSY_AGENT, async () => {
      const agent = await this.session.ensureAgent();
      await this.refreshProjectMap();
      // This session outlives every rewrite of the project map, the agent's own `update_context`
      // included, so the map is re-read per turn and never outranks the tool output. Refreshed
      // section by section, so a rewrite supersedes itself rather than invalidating the cached
      // prefix.
      const sections = appSections(await loadContext(this.session.dir));
      const delta = agent.refreshSystem(sections);
      this.noteSections(sections, delta);
      const focus = scene ? focusOnScene(await this.session.index(), scene) : undefined;
      await this.beginThread(input);
      this.session.record((convo) => asked(convo, input));
      try {
        const result = await agent.run(input, focus);
        this.session.record((convo) => answered(convo, result.final));
        if (wroteAuthoredInput(result.events)) this.session.mapStale = true;
        return result;
      } finally {
        // The turn is not over until the reply is written to disk. A crash a moment later must
        // not take the answer with it.
        await this.session.writes;
      }
    });
  }

  /**
   * Keep the native log's copy of the system prompt current. This runs before the turn's thread
   * exists, so on a thread's first turn the sections go into the header line the first message
   * writes, and from the second turn on a change is appended as a delta.
   */
  private noteSections(sections: SystemSection[], delta: SectionDelta | undefined): void {
    this.session.native.sections = sections;
    const id = this.session.thread?.id;
    if (!id || !this.session.native.opened || !delta) return;
    this.session.writeNative(id, {
      type : 'sections',
      n    : this.session.native.n,
      at   : new Date().toISOString(),
      set  : delta.set,
      unset: delta.unset,
    });
  }

  /**
   * Make sure there is a thread to write to. Because only a turn opens one, the first thing the
   * author said is already known when the header is written and can be its title outright — the
   * provisional title is what a thread keeps only until someone talks in it.
   *
   * A thread that cannot be opened costs a warning and nothing else: the conversation still
   * works on a read-only volume, it just is not saved.
   */
  private async beginThread(input: string): Promise<void> {
    if (this.session.thread) return;
    const paths = new ProjectPaths(this.session.dir);
    try {
      this.session.thread = await openThread(paths, {
        title: titleFrom(input),
        ...(this.session.model === '' ? {} : { model: this.session.model }),
        ...(this.session.effort === undefined ? {} : { effort: this.session.effort }),
      });
      this.session.step = 1;
    } catch (err) {
      console.warn(`[vnstudio] could not start a conversation thread: ${String(err)}`);
    }
  }

  async setMode(mode: AgentMode): Promise<AgentMode> {
    const agent = await this.session.ensureAgent();
    agent.setMode(mode);
    return agent.currentMode;
  }

  /**
   * Hot-swap the text model and rebuild the backend, preserving conversation state. The bound
   * effort is stepped down to what the new model offers — `xhigh` is not a level Sonnet 4.6
   * takes — so nothing downstream shows a setting the wire will not carry.
   */
  async setModel(modelId: string): Promise<string> {
    this.session.model = modelId;
    this.session.effort = resolveEffort(modelId, this.session.effort) ?? this.session.effort;
    await this.noteBinding();
    if (this.session.mock) return modelId;
    const agent = await this.session.ensureAgent();
    agent.setBackend(await this.session.buildBackend(await loadConfig(this.session.dir), modelId));
    return modelId;
  }

  /**
   * Hot-swaps the reasoning setting the same way. A model that honours none keeps the setting
   * anyway. A surface greys itself out based on `supportsEffort`, and the backend simply omits
   * the knob, so switching back to a model that does honour it needs no second gesture.
   */
  async setEffort(effort: EffortChoice): Promise<EffortChoice> {
    this.session.effort = effort;
    await this.noteBinding();
    if (this.session.mock) return effort;
    const agent = await this.session.ensureAgent();
    agent.setBackend(
      await this.session.buildBackend(
        await loadConfig(this.session.dir),
        this.session.model || undefined,
      ),
    );
    return effort;
  }

  /**
   * Write the current binding into the open thread, if there is one. A switch made before anyone
   * has said anything writes nothing — the thread that has not been opened yet will carry the
   * binding on its own line 0 — and a thread on a read-only volume costs a warning, like every
   * other write here.
   */
  private async noteBinding(): Promise<void> {
    if (!this.session.thread) return;
    const binding = {
      ...(this.session.model === '' ? {} : { model: this.session.model }),
      ...(this.session.effort === undefined ? {} : { effort: this.session.effort }),
    };
    this.session.thread = { ...this.session.thread, ...binding };
    try {
      await bindThread(new ProjectPaths(this.session.dir), this.session.thread.id, binding);
    } catch (err) {
      console.warn(`[vnstudio] could not record the conversation's model: ${String(err)}`);
    }
  }

  /**
   * The turn ceiling. Nothing is rebuilt and nothing is awaited beyond the agent existing: the
   * budget is read by the loop at each step, so a change lands on the turn in flight too.
   */
  async setBudget(budget: BudgetChoice): Promise<BudgetChoice> {
    this.session.budget = budget;
    (await this.session.ensureAgent()).setBudget(budget);
    return budget;
  }

  /**
   * The system prompt the next turn will carry, in its sections.
   *
   * Assembled from the project rather than read off `this.session.agent`, and deliberately so: `runAgent`
   * calls `refreshSystem(appSections(await loadContext(...)))` before every turn, so this is
   * exactly what the next turn sends — and it can be answered before an agent has ever been
   * built, which is when an author most wants to check what it was told.
   */
  async systemPrompt(): Promise<AgentSystem> {
    const context = await loadContext(this.session.dir);
    return {
      sections: appSections(context).map((section) => ({ ...section })),
      files   : context.files,
      modelId : this.session.model,
    };
  }

  /**
   * Start over. The thread is closed rather than deleted — a conversation that happened stays on
   * disk, and the next turn opens a new one — and it is committed on the way out, so that what
   * stays on disk also stays in history.
   */
  async clearAgent(): Promise<void> {
    (await this.session.ensureAgent()).clear();
    await this.session.writes;
    await this.commitThread();
    this.session.thread = undefined;
    this.session.convo = emptyConvo('');
    // The next thread opens its own log, from message zero and with its own header.
    this.session.native = {
      ...this.session.native,
      sections   : [],
      n          : 0,
      opened     : false,
      compactedTo: undefined,
      transport  : undefined,
    };
  }

  /**
   * Puts the conversation being closed into the project's history, and writes down where it
   * landed.
   *
   * Clearing a thread stops it from being watched. Nothing appends to that file again after
   * clearing, and the next thing to touch `vngen/state/` may well be an author tidying it. A
   * commit here makes "what did the agent do last Tuesday" answerable. The `Vn-Thread` trailer
   * lets a diagnostic find the commit through `git log --grep`, and the pointer written back
   * into the thread lets the thread find the commit without searching.
   *
   * This never fails, even when the project is not a repo, the repo has no committer identity,
   * or the volume is read-only. None of those is a reason to refuse to start a new
   * conversation.
   */
  private async commitThread(): Promise<void> {
    const thread = this.session.thread;
    if (!thread) return;
    const paths = new ProjectPaths(this.session.dir);
    try {
      const git = openGit(this.session.dir);
      if (!(await git.isRepo())) return;
      const file = threadFile(paths, thread.id);
      // Both files in one commit, so a conversation and the history that makes it resumable are
      // never in the project separately. `lastCommitFor` still asks about the display log, which
      // is the file every thread has.
      const native = nativeFile(paths, thread.id);
      const hasNative = await exists(native);
      // Nothing to commit means commit-on-save already recorded this transcript, so the answer is
      // the commit that did — the pointer records where the conversation is, not who put it there.
      const sha =
        (await git.commit({
          message : `Close conversation: ${thread.title}`,
          paths   : hasNative ? [file, native] : [file],
          trailers: { 'Vn-Thread': thread.id },
        })) ?? (await git.lastCommitFor(file));
      if (sha) await archiveThread(paths, thread.id, sha);
    } catch (err) {
      console.warn(`[vnstudio] could not commit the conversation just closed: ${String(err)}`);
    }
  }

  /**
   * Copy the author's own documents into `archive/`, verbatim. The rule lives in `@vn/authoring`
   * so the REPL's `/upload` and this land in the same place; the session only supplies the root.
   */
  async uploadFiles(files: string[]): Promise<UploadBatch> {
    return archiveUpload(new Workspace(this.session.dir), files);
  }

  /**
   * Tell the model something ahead of the author's next turn. What the conversation pane shows
   * the author is never sent to the model, so a fact the pane states — the upload that just
   * opened it — has to be filed this way for "this file" to mean anything.
   */
  async noteAgentContext(text: string): Promise<void> {
    (await this.session.ensureAgent()).noteContext(text);
  }

  /** Every saved conversation in this project, newest first, and which one is being written to. */
  async threads(): Promise<{ threads: ThreadHeader[]; active?: string }> {
    const threads = await listThreads(new ProjectPaths(this.session.dir));
    return { threads, ...(this.session.thread ? { active: this.session.thread.id } : {}) };
  }

  /**
   * A saved conversation, for reading. It ends the live one: the model is never shown what comes
   * back, so leaving the previous turns in its context while the screen shows another
   * conversation would leave the author and the agent talking about different things.
   */
  async openThreadForReading(id: string): Promise<OpenedThread> {
    const record = await readThread(new ProjectPaths(this.session.dir), id);
    await this.session.clearAgent();
    // Reopened on the binding it was recorded with, because a conversation reads as the model
    // that wrote it. Nothing is written here — `clearAgent` has already closed the live thread,
    // and the next turn opens a thread carrying this binding on its own line 0.
    if (record.model && record.model !== this.session.model)
      await this.session.setModel(record.model);
    if (record.effort && (EFFORT_CHOICES as readonly string[]).includes(record.effort)) {
      await this.session.setEffort(record.effort as EffortChoice);
    }
    const { state } = await this.resumeState(id);
    return { ...record, resume: state };
  }

  /**
   * What thread `id`'s stored history says about continuing it, and the log the answer came from.
   *
   * A log a merge damaged is reported rather than thrown: the answer is a refusal either way, and
   * the refusal has to reach a greyed button as a sentence.
   */
  private async resumeState(id: string): Promise<{ state: ResumeState; log?: NativeLog }> {
    try {
      const log = await readNative(new ProjectPaths(this.session.dir), id);
      return log ? { state: { header: log.header }, log } : { state: {} };
    } catch (err) {
      if (err instanceof ConflictedLogError) return { state: { damaged: true } };
      throw err;
    }
  }

  /**
   * Why thread `id` cannot be continued on the binding in force, or `undefined`. What
   * `agent.resumeThread` refuses with, and what its menu entry is greyed with.
   *
   * The agent is built first because building the backend is what settles which protocol it speaks
   * and which model it is bound to, and both are what the stored conversation is checked against.
   */
  async resumeRefusalFor(id: string): Promise<string | undefined> {
    const record = await readThread(new ProjectPaths(this.session.dir), id);
    if (this.session.thread?.id === id) {
      return `“${record.title}” is already the open conversation.`;
    }
    await this.session.ensureAgent();
    const { state } = await this.resumeState(id);
    return resumeRefusal(record.title, state, await this.binding(state));
  }

  /** The binding a stored conversation is checked against, with what main alone can fill in. */
  private async binding(state: ResumeState): Promise<ResumeBinding> {
    const transport = await this.session.continuingTransport(
      await loadConfig(this.session.dir),
      state.header === undefined ? undefined : headerTransport(state.header),
    );
    return {
      model  : this.session.model,
      backend: this.session.native.kind,
      ...(transport === undefined ? {} : { transport }),
    };
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
    const paths = new ProjectPaths(this.session.dir);
    const record = await readThread(paths, id);
    const agent = await this.session.ensureAgent();
    const { state, log } = await this.resumeState(id);
    const refusal = resumeRefusal(record.title, state, await this.binding(state));
    if (refusal) throw new Error(refusal);
    if (!log) throw new Error(`“${record.title}” has no history to continue from`);

    // Closes and commits whatever was open first, because `restore` replaces the transcript and a
    // half-written thread left bound would take the resumed conversation's later lines.
    await this.session.clearAgent();
    agent.restore({
      messages: [...restorable(liveMessages(log)), resumedNote(record)],
      sections: log.sections,
    });

    const { items, compactions, ...header } = record;
    this.session.thread = header;
    this.session.convo = replayed(this.session.convo, items, '', compactions);
    // Past the highest `n` the log holds, so a message written now cannot take the number of one
    // already in the file. The header is not rewritten: line 0 still describes this conversation.
    const highest = log.messages.reduce((max, message) => Math.max(max, message.n), -1);
    this.session.native = {
      ...this.session.native,
      sections   : log.sections,
      n          : highest + 1,
      opened     : true,
      compactedTo: log.compaction?.covers.to,
      transport  : headerTransport(log.header),
    };
    // Rebuilt under the pin just set, so the next turn goes through the transport the messages
    // were recorded in rather than the one the free route picked when the agent was built
    if (!this.session.mock) {
      agent.setBackend(
        await this.session.buildBackend(
          await loadConfig(this.session.dir),
          this.session.model || undefined,
        ),
      );
    }
    return record;
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
    if (!this.session.thread) return 'Nothing has been said in this conversation yet.';
    const live = (await this.session.ensureAgent()).transcript;
    const cut = lastCompleteTurn(live);
    if (cut < 0) return 'This conversation has no finished turn to summarize yet.';
    if (cut !== live.length - 1) {
      return 'The last turn stopped part way through a tool call. Send another turn first.';
    }
    if (this.session.native.compactedTo === this.session.native.n - 1) {
      return 'This conversation was compacted already, and nothing has been said since.';
    }
    return undefined;
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
    return this.session.while(BUSY_AGENT, async () => {
      const refusal = await this.session.compactRefusalFor();
      if (refusal) throw new Error(refusal);
      const thread = this.session.thread;
      if (!thread) throw new Error('no conversation is open');

      const agent = await this.session.ensureAgent();
      const covered = [...agent.transcript];
      const backend = await this.session.buildBackend(
        await loadConfig(this.session.dir),
        this.session.model || undefined,
      );
      const turn = await backend.next(COMPACTION_SYSTEM, compactionPrompt(covered), []);
      // A backend with nothing to call answers in `final`; `message` covers one that narrates
      // instead, so a summary is never lost to which field it arrived in.
      const summary = (turn.final ?? turn.message ?? '').trim();
      if (!summary) throw new Error('the model returned no summary, so nothing was compacted');

      // The call's own cost is reported before the compaction lands, because `compacted` drops the
      // context figure and this event would otherwise set it again from the prefix just replaced.
      if (turn.usage) {
        const event: AgentEvent = { type: 'usage', ...turn.usage };
        this.session.record((convo) => received(convo, event));
        this.session.deps.emitEvent(event);
      }

      const { messages } = compactRange(covered, summary);
      const head = messages[0];
      if (!head) throw new Error('the summary could not be built');
      const mode = agent.currentMode;
      agent.restore({ messages, sections: this.session.native.sections });
      // `restore` clears the agent, which puts it back in plan mode. The summary replaces what was
      // said, not the author's decision about what the agent may do.
      agent.setMode(mode);

      const at = new Date().toISOString();
      const to = this.session.native.n - 1;
      this.session.native.compactedTo = to;
      this.session.writeNative(thread.id, {
        type   : 'compact',
        covers : { from: 0, to },
        role   : head.role,
        content: typeof head.content === 'string' ? head.content : JSON.stringify(head.content),
        at,
        ...(this.session.model === '' ? {} : { model: this.session.model }),
        ...(turn.usage ? { usage: { input: turn.usage.input, output: turn.usage.output } } : {}),
      });

      const mark: CompactionMark = {
        afterId: this.session.convo.feed[this.session.convo.feed.length - 1]?.id ?? 0,
        covers : covered.length,
        text   : summary,
        at,
        ...(this.session.model === '' ? {} : { model: this.session.model }),
      };
      this.session.convo = compacted(this.session.convo, mark);
      const paths = new ProjectPaths(this.session.dir);
      this.session.writes = this.session.writes
        .then(() => appendCompaction(paths, thread.id, mark))
        .catch((err: unknown) => {
          console.warn(`[vnstudio] could not record the compaction: ${String(err)}`);
        });
      await this.session.writes;
      return mark;
    });
  }

  /** Rename a thread; an empty id means the one being written to. Refuses when there is none. */
  async renameThread(id: string, title: string): Promise<ThreadHeader> {
    const target = id.trim() === '' ? this.session.thread?.id : id.trim();
    if (!target) throw new Error('no conversation is open — name one to rename it');
    const named = title.trim();
    if (!named) throw new Error('a conversation needs a name');

    const paths = new ProjectPaths(this.session.dir);
    const { items: _items, ...header } = await readThread(paths, target);
    await retitleThread(paths, target, named);
    if (this.session.thread?.id === target)
      this.session.thread = { ...this.session.thread, title: named };
    return { ...header, title: named };
  }

  /**
   * The model and effort one analysis runs at. An empty field means whatever the agent is bound
   * to, so a scripted `report.agent(thread='t3')` does the sensible thing without naming a
   * model, and the dialog seeds both explicitly when a person opens it.
   *
   * Nothing here is written back: the analysis borrows the binding for one run, and an author who
   * switches to Opus to read a bad conversation has not rebound their agent.
   */
}
