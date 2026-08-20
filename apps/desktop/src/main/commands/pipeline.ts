/** The generative pipeline as commands: run to the next gate, stop a run, or read the state. */
import { defineFor, prop } from '@vn/commands';
import type { CommandHost } from './host.js';
import type { Approvable } from '@vn/authoring';

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
    // Before the await, not after: a run is the one command whose whole output is a list that
    // fills in while it happens, and a task list that arrives once it is over is a receipt. The
    // renderer focuses the pane already showing the list rather than making a second one, so an
    // author who keeps the Tasks editor docked never sees a popup at all.
    ctx.host.ui({ type: 'view', action: 'open', editor: 'tasklist', where: 'popup' }, ctx.origin);

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

/**
 * How many approve-then-run rounds {@link pipelineApproveAndRun} takes before handing control
 * back. A ceiling rather than a target: each round unlocks the next rung of the slot graph —
 * portrait, then sheet, then plate, then shot — so a project still going after this many is a
 * project with something wrong in it, and an unbounded loop would spend real image calls
 * discovering that.
 */
export const MAX_ROUNDS = 12;

/** What one approve-then-run round managed. */
export interface RoundOutcome {
  /** Pictures approved at the top of the round. */
  approved: number;
  /** Tasks the run executed. */
  ran: number;
  /** Tasks the current plan wants that are failed — inherited failures included. */
  failed: number;
  /** True when the author stopped the run. */
  stopped: boolean;
}

/**
 * Why the loop stops after this round, or `''` to take another.
 *
 * Split out and pinned by tests because it is the whole feature: every branch is one that either
 * spends more real image calls or stops short of finishing the art, and an author only finds out
 * which afterwards.
 */
export function stopReason(outcome: RoundOutcome, round: number, cap = MAX_ROUNDS): string {
  if (outcome.stopped) return 'stopped on request';
  // The convergence test, and the only ending that means success: nothing was waiting to be
  // approved and the planner had nothing left to do.
  if (outcome.approved === 0 && outcome.ran === 0) return 'everything is generated and approved';
  // A round that approved nothing and failed everything it tried will do the same again. Terminal
  // tasks are retried once by the scheduler, so this is the failure that has already been retried.
  if (outcome.approved === 0 && outcome.ran > 0 && outcome.failed >= outcome.ran) {
    return 'every task in the last round failed';
  }
  if (round + 1 >= cap) return `stopped after ${cap} rounds`;
  return '';
}

/**
 * The rows to approve this round: everything not blocked, and — at the character gate — at most
 * one portrait per character.
 *
 * The gate is the one door whose candidates are alternatives rather than separate pictures:
 * approving two portraits of Aiko in one pass is not approving two things, it is choosing her
 * look and then changing it. The first is taken because `approvable` lists upstream-first in slot
 * order, which is the project's own idea of the obvious one.
 */
export function toApprove(items: readonly Approvable[]): Approvable[] {
  const chosen: Approvable[] = [];
  const gated = new Set<string>();
  for (const item of items) {
    if (item.blocked) continue;
    if (item.door === 'gate') {
      // A portrait of nobody clears nobody from the gate — `approveOne` says exactly that, and
      // skipping it here keeps the loop from asking once a round for as long as it runs.
      const who = item.characterId;
      if (!who || gated.has(who)) continue;
      gated.add(who);
    }
    chosen.push(item);
  }
  return chosen;
}

export const pipelineApproveAndRun = define({
  id: 'pipeline.approveAndRun',
  title: 'Approve and generate everything',
  description:
    'Approve every picture that is waiting and run the pipeline, over and over, until nothing ' +
    'is left to approve and nothing is left to generate. Each round unlocks the next rung — an ' +
    'approved portrait clears the gate, an approved sheet lets its plates plan — so this is a ' +
    'whole art pass as one act. It spends real model calls and approves on your behalf; Stop ' +
    'pipeline ends it after the task in progress.',
  mutating: true,
  // The one command that both approves art and spends money without asking again in between.
  // Every step is undoable on its own and the pass is not undoable as a whole, which is exactly
  // when a confirmation earns its place.
  confirm: true,
  props: {},
  async check(_props, ctx) {
    const busy = ctx.host.session.busy();
    if (busy) return { ok: false, reason: `${busy} is already in progress.` };
    const state = await ctx.host.session.runPreconditions(false);
    if (state.keyError) return { ok: false, reason: state.keyError };
    const waiting = toApprove(await ctx.host.session.approvable()).length;
    return {
      ok: true,
      note: [
        `${waiting} picture(s) would be approved, then ${state.pending} planned task(s) run.`,
        `Each round unlocks more, and it repeats until nothing is left — up to ${MAX_ROUNDS} rounds.`,
        'This spends real model calls.',
      ].join('\n'),
    };
  },
  async run(_props, ctx) {
    // Same reasoning as `pipeline.run`, and more so: the list fills in while this happens, and it
    // happens for a while. Opened before the first await, so it is company rather than a receipt.
    ctx.host.ui({ type: 'view', action: 'open', editor: 'tasklist', where: 'popup' }, ctx.origin);

    let approved = 0;
    let ran = 0;
    let failed = 0;
    let rounds = 0;
    let why = `stopped after ${MAX_ROUNDS} rounds`;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      rounds = round + 1;
      let approvedNow = 0;
      for (const item of toApprove(await ctx.host.session.approvable())) {
        const outcome = await ctx.host.session.approveOne(item);
        // A refusal does not abandon the pass: the rows are re-derived every round, so whatever
        // refused is either already handled or listed again next time with its own sentence.
        if (outcome.ok) approvedNow++;
      }
      approved += approvedNow;

      const result = await ctx.host.session.runPipeline(false);
      ran += result.ran;
      failed = result.failed;

      const reason = stopReason(
        {
          approved: approvedNow,
          ran: result.ran,
          failed: result.failed,
          stopped: result.stopped === true,
        },
        round,
      );
      if (reason) {
        why = reason;
        break;
      }
    }

    const trouble = failed > 0 ? `, ${failed} failed` : '';
    return {
      message: `${approved} approved, ${ran} task(s) ran over ${rounds} round(s)${trouble} — ${why}.`,
      data: { approved, ran, failed, rounds, why },
      written: ['vngen/build/', 'vngen/state/tasks.jsonl', 'vngen/build/manifest.json'],
    };
  },
});
