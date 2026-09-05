/**
 * The authoring agent as commands. `agent.run` is marked mutating because a turn in execute mode
 * can edit files. The agent keeps its own plan/execute gate, and these commands do not bypass it.
 */
import { defineFor, prop, type CommandContext } from '@vn/commands';
import {
  BUDGET_CHOICES,
  EFFORT_CHOICES,
  effortLabel,
  type BudgetChoice,
  type EffortChoice,
} from '@vn/types';
import { assetOpener, lineOpener } from '../../shared/agentseed.js';
import { BUSY_AGENT } from '../../shared/ipc.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const agentRun = define({
  id         : 'agent.run',
  title      : 'Run agent turn',
  description: 'Send one turn to the authoring agent and return its result.',
  notes      : 'One agent turn. Mutating: a turn in execute mode writes.',
  mutating   : true,
  props: {
    input: prop.string('what to ask the agent'),
    // Filled by the composer from the selection. Optional because the palette and CDP have no
    // selection, and a turn runs the same way with no scene in view
    scene: prop.string('the scene the author has open, so "this scene" means that one', {
      default: '',
    }),
  },
  async run({ input, scene }, ctx) {
    // The turn's cards belong to the window whose composer sent it. Without this note an ask goes
    // to whichever window holds focus, which lands the card away from the author once they are
    // reading in another window
    ctx.host.noteTurnWindow(ctx.origin);
    const result = await ctx.host.session.runAgent(input, scene || undefined);
    // The reply is prose the conversation pane renders, so the commit takes the ask instead
    return { message: result.final, subject: `Agent turn: ${input}`, data: result };
  },
});

export const agentStop = define({
  id         : 'agent.stop',
  title      : 'Stop agent turn',
  description: 'End the turn in progress after the step it is on. What it already did is kept.',
  // The interrupted turn accounts for whatever it wrote, and already holds the undo point
  mutating   : false,
  props      : {},
  check(_props, ctx) {
    // Asks whether an agent turn is in flight rather than whether it is what `busy()` names: a
    // report turn running alongside it would otherwise make this refuse the turn it can stop
    if (!ctx.host.session.running(BUSY_AGENT))
      return Promise.resolve({ ok: false, reason: 'The agent is idle.' });
    return Promise.resolve({ ok: true, note: 'The turn ends after the step it is on.' });
  },
  run(_props, ctx) {
    const asked = ctx.host.session.stopAgent();
    return Promise.resolve({
      message: asked ? 'Stopping after the step in progress.' : 'The agent is idle.',
    });
  },
});

export const agentSetMode = define({
  id         : 'agent.setMode',
  title      : 'Set agent mode',
  description: 'Switch the agent between read-only plan mode and execute mode.',
  mutating   : false,
  props      : { mode: prop.oneOf(['plan', 'execute'] as const, 'the mode to switch to') },
  async run({ mode }, ctx) {
    const current = await ctx.host.session.setMode(mode);
    return { message: `Agent is in ${current} mode.`, data: current };
  },
});

export const agentSetModel = define({
  id         : 'agent.setModel',
  title      : 'Set agent model',
  description: 'Hot-swap the text model, preserving conversation state.',
  notes      : 'Hot-swaps the text model, preserving conversation state.',
  mutating   : false,
  props      : { modelId: prop.string('the model id to bind') },
  async run({ modelId }, ctx) {
    return { message: `Agent model is now ${await ctx.host.session.setModel(modelId)}.` };
  },
});

export const agentSetEffort = define({
  id         : 'agent.setEffort',
  title      : 'Set agent effort',
  description: 'Set how hard the model thinks, or `none` to switch thinking off.',
  notes:
    'How hard the model thinks; `none` switches thinking off. Every choice is accepted — the menu is what filters by model, and one the model will not take is stepped down at the wire (`resolveEffort`). A model with no such knob keeps the setting and ignores it (`supportsEffort`).',
  mutating   : false,
  // Every choice is accepted, not just the ones the current model offers. The menu does the
  // filtering, and a level the model will not take is stepped down at the wire rather than refused
  props      : { effort: prop.oneOf(EFFORT_CHOICES, 'the reasoning to bind') },
  async run({ effort }, ctx) {
    const bound = await ctx.host.session.setEffort(effort as EffortChoice);
    return { message: `Agent effort is now ${effortLabel(bound)}.` };
  },
});

/** Where the chosen ceiling is remembered between runs of the app. */
export const BUDGET_KEY = 'agent.budget';

export const agentSetBudget = define({
  id         : 'agent.setBudget',
  title      : 'Set agent turn budget',
  description:
    'How many non-cached tokens one turn may spend before the agent is asked to wrap up. Cache ' +
    'reads do not count. `unlimited` removes the ceiling.',
  mutating   : false,
  props      : { budget: prop.oneOf(BUDGET_CHOICES, 'the ceiling to bind') },
  async run({ budget }, ctx) {
    const bound = await ctx.host.session.setBudget(budget as BudgetChoice);
    // Kept in the install's session file rather than the project's, because the ceiling is a
    // spending decision about this machine and author that a collaborator does not inherit
    ctx.host.state.set(BUDGET_KEY, bound);
    return { message: `Agent turn budget is now ${bound}.` };
  },
});

export const agentClear = define({
  id         : 'agent.clear',
  title      : 'Clear agent context',
  description: 'Reset the conversation, returning the agent to plan mode. The thread is saved.',
  notes:
    'Resets the conversation, back to plan mode. The thread it was in stays on disk and stays listed.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    await ctx.host.session.clearAgent();
    return { message: 'Agent context cleared.' };
  },
});

/**
 * The six thread commands. None is `undoable`, because `vngen/state` sits outside the undo
 * snapshot, so a journal entry could not actually restore a transcript. `agent.renameThread` and
 * `agent.compact` are the two marked `mutating`, and only because each writes a file.
 */
export const agentThreads = define({
  id         : 'agent.threads',
  title      : 'List conversations',
  description: 'Every saved conversation in this project, newest first.',
  notes:
    'Every saved conversation, newest first, plus which one is open. Header lines only — no transcripts.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const { threads, active } = await ctx.host.session.threads();
    const count = threads.length === 1 ? '1 conversation' : `${threads.length} conversations`;
    return { message: `${count} saved.`, data: { threads, active } };
  },
});

export const agentNewThread = define({
  id         : 'agent.newThread',
  title      : 'New conversation',
  description: 'Save the current conversation and start a fresh one.',
  notes      : 'End the open conversation and start again. The next turn opens a new thread file.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    await ctx.host.session.clearAgent();
    return { message: 'Started a new conversation.' };
  },
});

export const agentOpenThread = define({
  id         : 'agent.openThread',
  title      : 'Open conversation',
  description:
    'Replay a saved conversation on screen. Read-only: the agent is not shown it until ' +
    'Continue hands it back.',
  notes:
    'Replay a saved conversation on screen. **Read-only**: the model is not shown it, and the next turn starts a new thread unless Continue is pressed first. Returns the whole record as `data`.',
  mutating   : false,
  props      : { id: prop.string('the conversation to reopen') },
  async run({ id }, ctx) {
    const record = await ctx.host.session.openThreadForReading(id);
    return { message: `Reopened “${record.title}” for reading.`, data: record };
  },
});

/**
 * Continuing, which is the one thread command that changes what the agent holds. It is checked
 * rather than merely offered: a conversation recorded through another vendor or another protocol
 * cannot be handed to the model bound now, and the check is where that sentence comes from.
 */
export const agentResumeThread = define({
  id         : 'agent.resumeThread',
  title      : 'Continue conversation',
  description: 'Continue a saved conversation. The agent is shown everything already in it.',
  notes:
    'Continue a saved conversation: the agent is handed the messages from its native log and the session binds to that thread, so later turns append to the same two files. Not mutating — it changes what the agent holds, not the project. Checked because a conversation recorded through another vendor or another protocol cannot be handed to the model bound now; the check answers that sentence, along with a log merged from two clones, one written by a newer version of the app, and a thread that kept only its transcript.',
  mutating   : false,
  props      : { id: prop.string('the conversation to continue') },
  check: async ({ id }, ctx) => {
    const free = idle(ctx.host);
    if (!free.ok) return free;
    const { threads } = await ctx.host.session.threads();
    const found = threads.find((thread) => thread.id === id);
    if (!found) return { ok: false, reason: `No conversation ${id}.` };
    const refusal = await ctx.host.session.resumeRefusalFor(id);
    return refusal
      ? { ok: false, reason: refusal }
      : { ok: true, note: `Continues “${found.title}”.` };
  },
  async run({ id }, ctx) {
    const record = await ctx.host.session.resumeThread(id);
    return { message: `Continuing “${record.title}”.`, data: record };
  },
});

/** Decides what a rename would target: the named thread, or the open one when no id is given. */
async function wouldRename(
  id: string,
  title: string,
  session: CommandHost['session'],
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  if (!title.trim()) return { ok: false, reason: 'Give the conversation a name.' };
  const { threads, active } = await session.threads();
  const target = id.trim() || active;
  if (!target) return { ok: false, reason: 'No conversation is open — name the one to rename.' };
  const found = threads.find((t) => t.id === target);
  if (!found) return { ok: false, reason: `No conversation ${target}.` };
  return { ok: true, note: `Renames “${found.title}” to “${title.trim()}”.` };
}

export const agentRenameThread = define({
  id         : 'agent.renameThread',
  title      : 'Rename conversation',
  description: 'Retitle a saved conversation; an empty id renames the one that is open.',
  notes:
    'Retitle a saved conversation; an empty `id` renames the open one. Appended as a superseding `title` record — the log stays append-only, and the last one read wins.',
  mutating   : true,
  props: {
    id   : prop.string('the conversation to rename, or empty for the open one', { default: '' }),
    title: prop.string('the new name'),
  },
  check      : ({ id, title }, ctx) => wouldRename(id, title, ctx.host.session),
  async run({ id, title }, ctx) {
    const header = await ctx.host.session.renameThread(id, title);
    return { message: `Renamed to “${header.title}”.`, data: header };
  },
});

/**
 * Compacting: a summary of what has been said replaces the messages the agent carries, so a long
 * conversation keeps going without resending every turn. It is `mutating` because it appends to
 * both of the thread's logs, and it costs a model call, which is what the check reports.
 */
export const agentCompact = define({
  id         : 'agent.compact',
  title      : 'Compact conversation',
  description:
    'Summarize this conversation so the agent carries a summary instead of every turn. Nothing ' +
    'is deleted — the transcript on screen is unchanged.',
  notes:
    "Summarize the open conversation so the agent carries a summary instead of every turn. Appends one line to each of the thread's logs and rewrites neither, so the transcript on screen is unchanged. Checked because it costs a model call, and refused while a turn is running, with no finished turn to summarize, with the last turn stopped part way through a tool call, and when nothing has been said since the last compaction.",
  mutating   : true,
  props      : {},
  check: async (_props, ctx) => {
    const free = idle(ctx.host);
    if (!free.ok) return free;
    const refusal = await ctx.host.session.compactRefusalFor();
    return refusal
      ? { ok: false, reason: refusal }
      : { ok: true, note: 'Costs one model call, on the model this conversation is bound to.' };
  },
  async run(_props, ctx) {
    const mark = await ctx.host.session.compactThread();
    return { message: `Compacted ${mark.covers} messages.`, data: mark };
  },
});

/**
 * The two openers: a surface points the agent at what the author is looking at, and the composer
 * arrives already naming it.
 *
 * Neither sends a turn and neither touches the conversation. Each opens the pane, and returns its
 * sentence as `data.seed` for the composer to hold — so the palette running one has the same effect
 * as the right-click that normally does, and the author still writes and sends the turn.
 *
 * Whether the opener needs a fresh conversation is the renderer's decision rather than one made
 * here. A reopened thread is on screen without being live, so main's own copy of the conversation
 * is empty exactly when the author can see a full one.
 */
function idle(host: CommandHost): { ok: true } | { ok: false; reason: string } {
  const busy = host.session.busy();
  return busy
    ? { ok: false, reason: `${busy} is still running; wait for it to finish.` }
    : { ok: true };
}

/** The view effect both openers push: the conversation, in a pane of its own, outlined on arrival. */
function showConvo(ctx: CommandContext<CommandHost>): void {
  ctx.host.ui(
    { type: 'view', action: 'open', editor: 'convo', where: 'elsewhere', flash: true },
    ctx.origin,
  );
}

/** The opener one line of a scene would arrive with, or why there is none. */
async function wouldEditLine(
  scene: string,
  line: string,
  host: CommandHost,
): Promise<{ ok: true; seed: string } | { ok: false; reason: string }> {
  const free = idle(host);
  if (!free.ok) return free;
  let coverage;
  try {
    coverage = await host.session.sceneCoverage(scene);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const seed = lineOpener(coverage, line);
  return seed ? { ok: true, seed } : { ok: false, reason: `Scene ${scene} has no line ${line}.` };
}

export const agentEditLine = define({
  id         : 'agent.editLine',
  title      : 'Edit with the agent',
  description:
    'Open the conversation on one line of a scene, with the composer already naming it — the ' +
    'scene, the line’s number in it, its id and its words. Nothing is sent: the opener is text in ' +
    'a field, and what to ask for is the author’s to write.',
  mutating   : false,
  props: {
    scene: prop.string('the scene the line is in'),
    line : prop.string('the line id, which the script column’s gutter tooltip names'),
  },
  check: ({ scene, line }, ctx) =>
    wouldEditLine(scene, line, ctx.host).then((v) =>
      v.ok ? { ok: true as const, note: 'Opens a conversation about this line.' } : v,
    ),
  async run({ scene, line }, ctx) {
    const verdict = await wouldEditLine(scene, line, ctx.host);
    if (!verdict.ok) throw new Error(verdict.reason);
    showConvo(ctx);
    return { message: `Asking about ${line} of ${scene}.`, data: { seed: verdict.seed } };
  },
});

/** The opener a failed picture would arrive with, or why there is none. */
async function wouldFixAsset(
  hash: string,
  host: CommandHost,
): Promise<{ ok: true; seed: string } | { ok: false; reason: string }> {
  const free = idle(host);
  if (!free.ok) return free;
  const info = await host.session.assetInfo(hash);
  if (!info) return { ok: false, reason: `No asset ${hash}.` };
  const seed = assetOpener(info);
  return seed
    ? { ok: true, seed }
    : { ok: false, reason: `“${info.label}” has not failed — there is nothing to fix.` };
}

export const agentFixAsset = define({
  id         : 'agent.fixAsset',
  title      : 'Fix with the agent',
  description:
    'Open the conversation on a picture the pipeline gave up on, with the composer holding what ' +
    'the failure said and a request to work out why. Nothing is sent, and nothing is regenerated ' +
    '— the agent proposes a change to the prompt or the art notes, and a run is what redraws it.',
  mutating   : false,
  props      : { hash: prop.string('the asset that failed') },
  check: ({ hash }, ctx) =>
    wouldFixAsset(hash, ctx.host).then((v) =>
      v.ok ? { ok: true as const, note: 'Opens a conversation about this failure.' } : v,
    ),
  async run({ hash }, ctx) {
    const verdict = await wouldFixAsset(hash, ctx.host);
    if (!verdict.ok) throw new Error(verdict.reason);
    showConvo(ctx);
    return { message: 'Asking about what went wrong.', data: { seed: verdict.seed } };
  },
});
