/** The generative pipeline as commands: run to the next gate, or read the current state. */
import { defineFor, prop } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const pipelineStatus = define({
  id: 'pipeline.status',
  title: 'Pipeline status',
  description: 'Task counts, gate-pending characters, and whether the run is gate-blocked.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const status = await ctx.host.session.status();
    const blocked = status.blockedOnGate ? ', blocked on the approval gate' : '';
    return { message: `${status.tasks.length} task(s)${blocked}.`, data: status };
  },
});

export const pipelineRun = define({
  id: 'pipeline.run',
  title: 'Run pipeline',
  description:
    'Plan and execute to the next gate. A dry run previews the work without calling a model.',
  mutating: true,
  // A real run spends money and writes assets; a dry run does neither, but the gate is on
  // the command, not the props, so the confirmation is unconditional.
  confirm: true,
  props: { mock: prop.boolean('dry run: preview only, no model calls', { default: true }) },
  async run({ mock }, ctx) {
    const result = await ctx.host.session.runPipeline(mock);
    const what = mock
      ? `${result.preview.pendingTasks} pending task(s) previewed`
      : `${result.ran} task(s) ran`;
    return {
      message: `${what}${result.blockedOnGate ? ', halted at the gate' : '.'}`,
      data: result,
      ...(mock ? {} : { written: ['vngen/build/', 'vngen/state/tasks.jsonl'] }),
    };
  },
});
