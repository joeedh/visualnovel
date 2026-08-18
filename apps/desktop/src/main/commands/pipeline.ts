/** The generative pipeline as commands: run to the next gate, stop a run, or read the state. */
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
  // Deliberately not `confirm`. Every door to this — the header's button, the menu entry, the
  // advanced dialog's OK — is already a deliberate click on the words "run pipeline", and a
  // second card saying them again was one the author dismissed without reading.
  props: { mock: prop.boolean('dry run: preview only, no model calls', { default: true }) },
  async check({ mock }, ctx) {
    // The session runs one long thing at a time, and a second run would plan against a graph
    // the first is still writing. Named, because "an agent turn" is the case worth waiting out.
    const busy = ctx.host.session.busy();
    if (busy) return { ok: false, reason: `${busy} is already in progress.` };
    const state = await ctx.host.session.runPreconditions(mock);
    if (state.keyError) return { ok: false, reason: state.keyError };

    // Pending work is reported, never refused: planning is incremental, so "nothing pending"
    // means nothing is plannable *yet* — the run itself is what discovers the rest.
    const kinds = Object.entries(state.byKind)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => `${n} ${kind.replace(/_/g, ' ')}`)
      .join(', ');
    const lines = [
      `${state.pending} task(s) planned${kinds ? `: ${kinds}` : ''}.`,
      `Upper bound: ${state.imageCalls} image call(s), ${state.reviewCalls} review call(s).`,
      mock
        ? 'Dry run: nothing is rendered and no model is called.'
        : 'This spends real model calls.',
    ];
    if (state.blockedOnGate) {
      lines.push(
        `The run halts at the character gate — awaiting approval: ${state.gatePending.join(', ') || 'none'}.`,
      );
    }
    // Planning is incremental, so the count above is what is plannable *now*.
    if (state.pending > 0) lines.push('A later wave may unlock more.');
    return { ok: true, note: lines.join('\n') };
  },
  async run({ mock }, ctx) {
    const result = await ctx.host.session.runPipeline(mock);
    const what = mock
      ? `${result.preview.pendingTasks} pending task(s) previewed`
      : `${result.ran} task(s) ran`;
    // Counted from the plan, so a failure inherited from an earlier run still shows: without
    // this the palette reported a clean run over art that does not exist.
    const failed = result.failed ? `, ${result.failed} failed` : '';
    const how = result.stopped ? ', stopped' : result.blockedOnGate ? ', halted at the gate' : '.';
    return {
      message: `${what}${failed}${how}`,
      data: result,
      ...(mock ? {} : { written: ['vngen/build/', 'vngen/state/tasks.jsonl'] }),
    };
  },
});

export const pipelineStop = define({
  id: 'pipeline.stop',
  title: 'Stop pipeline',
  description: 'Stop the run in progress after the task it is on. Finished work is kept.',
  // A stop writes nothing of its own — the run it interrupts records what it managed, and that
  // is already `pipeline.run`'s undo point.
  mutating: false,
  props: {},
  check(_props, ctx) {
    const busy = ctx.host.session.busy();
    if (busy !== 'a pipeline run') {
      return Promise.resolve({ ok: false, reason: 'No pipeline run is in progress.' });
    }
    return Promise.resolve({ ok: true, note: 'The run stops after the task it is on.' });
  },
  run(_props, ctx) {
    const asked = ctx.host.session.stopPipeline();
    return Promise.resolve({
      message: asked ? 'Stopping after the task in progress.' : 'No pipeline run is in progress.',
    });
  },
});
