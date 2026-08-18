/**
 * The authoring agent as commands. `agent.run` is marked mutating because a turn in execute
 * mode can edit files — but the agent keeps its own plan/execute gate, which this does not
 * bypass: the command is just another way to hand it a turn.
 */
import { defineFor, prop } from '@vn/commands';
import {
  BUDGET_CHOICES,
  EFFORT_CHOICES,
  effortLabel,
  type BudgetChoice,
  type EffortChoice,
} from '@vn/types';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const agentRun = define({
  id: 'agent.run',
  title: 'Run agent turn',
  description: 'Send one turn to the authoring agent and return its result.',
  mutating: true,
  props: {
    input: prop.string('what to ask the agent'),
    // Filled by the composer from the selection. Optional because the palette and CDP have no
    // selection to speak of, and a turn with no scene in view is a turn like any other.
    scene: prop.string('the scene the author has open, so "this scene" means that one', {
      default: '',
    }),
  },
  async run({ input, scene }, ctx) {
    const result = await ctx.host.session.runAgent(input, scene || undefined);
    return { message: result.final, data: result };
  },
});

export const agentStop = define({
  id: 'agent.stop',
  title: 'Stop agent turn',
  description: 'End the turn in progress after the step it is on. What it already did is kept.',
  // The turn it interrupts owns whatever was written, and is where the undo point already is.
  mutating: false,
  props: {},
  check(_props, ctx) {
    const busy = ctx.host.session.busy();
    if (busy !== 'an agent turn')
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
  id: 'agent.setMode',
  title: 'Set agent mode',
  description: 'Switch the agent between read-only plan mode and execute mode.',
  mutating: false,
  props: { mode: prop.oneOf(['plan', 'execute'] as const, 'the mode to switch to') },
  async run({ mode }, ctx) {
    const current = await ctx.host.session.setMode(mode);
    return { message: `Agent is in ${current} mode.`, data: current };
  },
});

export const agentSetModel = define({
  id: 'agent.setModel',
  title: 'Set agent model',
  description: 'Hot-swap the text model, preserving conversation state.',
  mutating: false,
  props: { modelId: prop.string('the model id to bind') },
  async run({ modelId }, ctx) {
    return { message: `Agent model is now ${await ctx.host.session.setModel(modelId)}.` };
  },
});

export const agentSetEffort = define({
  id: 'agent.setEffort',
  title: 'Set agent effort',
  description: 'Set how hard the model thinks, or `none` to switch thinking off.',
  mutating: false,
  // Every choice is accepted, not just the ones the current model offers: the menu is what
  // filters, and a level the model will not take is stepped down at the wire, not refused.
  props: { effort: prop.oneOf(EFFORT_CHOICES, 'the reasoning to bind') },
  async run({ effort }, ctx) {
    const bound = await ctx.host.session.setEffort(effort as EffortChoice);
    return { message: `Agent effort is now ${effortLabel(bound)}.` };
  },
});

/** Where the chosen ceiling is remembered between runs of the app. */
export const BUDGET_KEY = 'agent.budget';

export const agentSetBudget = define({
  id: 'agent.setBudget',
  title: 'Set agent turn budget',
  description:
    'Cap what one agent turn may spend, in tokens the cache did not serve. Persists between sessions.',
  mutating: false,
  props: { budget: prop.oneOf(BUDGET_CHOICES, 'what one turn may spend') },
  async run({ budget }, ctx) {
    const bound = await ctx.host.session.setBudget(budget as BudgetChoice);
    // Kept in the install's session file rather than the project's: it is a spending decision
    // about this machine and this author, not something a collaborator inherits with the repo.
    ctx.host.state.set(BUDGET_KEY, bound);
    return { message: `One agent turn may now spend ${bound} non-cached tokens.` };
  },
});

export const agentClear = define({
  id: 'agent.clear',
  title: 'Clear agent context',
  description: 'Reset the conversation, returning the agent to plan mode. The thread is saved.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    await ctx.host.session.clearAgent();
    return { message: 'Agent context cleared.' };
  },
});

/**
 * The four thread commands. None is `undoable`: `vngen/state` is outside the undo snapshot by
 * design, so a journal entry claiming to restore a transcript could not — and `agent.renameThread`
 * is `mutating` only because it writes a file, which is also why it is the only one of the four
 * that is.
 */
export const agentThreads = define({
  id: 'agent.threads',
  title: 'List conversations',
  description: 'Every saved conversation in this project, newest first.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const { threads, active } = await ctx.host.session.threads();
    const count = threads.length === 1 ? '1 conversation' : `${threads.length} conversations`;
    return { message: `${count} saved.`, data: { threads, active } };
  },
});

export const agentNewThread = define({
  id: 'agent.newThread',
  title: 'New conversation',
  description: 'Save the current conversation and start a fresh one.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    await ctx.host.session.clearAgent();
    return { message: 'Started a new conversation.' };
  },
});

export const agentOpenThread = define({
  id: 'agent.openThread',
  title: 'Open conversation',
  description: 'Replay a saved conversation on screen. Read-only: the agent is not shown it.',
  mutating: false,
  props: { id: prop.string('the conversation to reopen') },
  async run({ id }, ctx) {
    const record = await ctx.host.session.openThreadForReading(id);
    return { message: `Reopened “${record.title}” for reading.`, data: record };
  },
});

/** What renaming would hit — the open thread when no id is named, and nothing when none is. */
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
  id: 'agent.renameThread',
  title: 'Rename conversation',
  description: 'Retitle a saved conversation; an empty id renames the one that is open.',
  mutating: true,
  props: {
    id: prop.string('the conversation to rename, or empty for the open one', { default: '' }),
    title: prop.string('the new name'),
  },
  check: ({ id, title }, ctx) => wouldRename(id, title, ctx.host.session),
  async run({ id, title }, ctx) {
    const header = await ctx.host.session.renameThread(id, title);
    return { message: `Renamed to “${header.title}”.`, data: header };
  },
});
