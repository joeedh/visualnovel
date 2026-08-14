/**
 * The authoring agent as commands. `agent.run` is marked mutating because a turn in execute
 * mode can edit files — but the agent keeps its own plan/execute gate, which this does not
 * bypass: the command is just another way to hand it a turn.
 */
import { defineFor, prop } from '@vn/commands';
import { EFFORT_LEVELS, type Effort } from '@vn/types';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

// `default` is the absence of the knob, not a level — a prop has to name it to be able to say it.
const EFFORT_CHOICES = ['default', ...EFFORT_LEVELS] as const;

export const agentRun = define({
  id: 'agent.run',
  title: 'Run agent turn',
  description: 'Send one turn to the authoring agent and return its result.',
  mutating: true,
  props: { input: prop.string('what to ask the agent') },
  async run({ input }, ctx) {
    const result = await ctx.host.session.runAgent(input);
    return { message: result.final, data: result };
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
  description: 'Set how hard the model thinks, or `default` to leave the knob off.',
  mutating: false,
  props: { effort: prop.oneOf(EFFORT_CHOICES, 'the reasoning effort to bind') },
  async run({ effort }, ctx) {
    const level = effort === 'default' ? undefined : (effort as Effort);
    await ctx.host.session.setEffort(level);
    return { message: `Agent effort is now ${level ?? 'default'}.` };
  },
});

export const agentClear = define({
  id: 'agent.clear',
  title: 'Clear agent context',
  description: 'Reset the conversation, returning the agent to plan mode.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    await ctx.host.session.clearAgent();
    return { message: 'Agent context cleared.' };
  },
});
