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
  async check({ mock }, ctx) {
    const state = await ctx.host.session.runPreconditions(mock);
    if (state.keyError) return { ok: false, reason: state.keyError };
    // Pending work is reported, never refused: planning is incremental, so "nothing pending"
    // means nothing is plannable *yet* — the run itself is what discovers the rest.
    const gate = state.blockedOnGate
      ? ` Gate pending: ${state.gatePending.join(', ') || 'none'}.`
      : '';
    return { ok: true, note: `${state.pending} task(s) pending.${gate}` };
  },
  async run({ mock }, ctx) {
    const result = await ctx.host.session.runPipeline(mock);
    const what = mock
      ? `${result.preview.pendingTasks} pending task(s) previewed`
      : `${result.ran} task(s) ran`;
    // Counted from the plan, so a failure inherited from an earlier run still shows: without
    // this the palette reported a clean run over art that does not exist.
    const failed = result.failed ? `, ${result.failed} failed` : '';
    return {
      message: `${what}${failed}${result.blockedOnGate ? ', halted at the gate' : '.'}`,
      data: result,
      ...(mock ? {} : { written: ['vngen/build/', 'vngen/state/tasks.jsonl'] }),
    };
  },
});
