/** Commands for the generative pipeline: run to the next gate, stop a run, or read the state. */
import { defineFor, prop } from '@vn/commands';
import { BUSY_PASS, BUSY_RUN, stopsWhat } from '../../shared/ipc.js';
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
  // Deliberately not `confirm`. The header's button, the menu entry and the advanced dialog's OK
  // are each already a deliberate click on the words "run pipeline", so a second card repeating
  // them gets dismissed without being read.
  props: { mock: prop.boolean('dry run: preview only, no model calls', { default: true }) },
  async check({ mock }, ctx) {
    // The session runs one long thing at a time, and a second run would plan against a graph the
    // first is still writing. The refusal names what is busy, whether a pipeline run or an agent
    // turn, because either would race the graph this command is about to plan against.
    const busy = ctx.host.session.busy();
    if (busy) return { ok: false, reason: `${busy} is already in progress.` };
    const state = await ctx.host.session.runPreconditions(mock);
    if (state.keyError) return { ok: false, reason: state.keyError };

    // Pending work is reported, never refused. Planning is incremental, so "nothing pending" means
    // nothing is plannable yet, and the run itself is what discovers the rest.
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
    // Planning is incremental, so the planned count covers only what is plannable at this point
    if (state.pending > 0) lines.push('A later wave may unlock more.');
    return { ok: true, note: lines.join('\n') };
  },
  async run({ mock }, ctx) {
    // Opened before the await: the task list fills in while the run happens, so opening it
    // afterwards would show only the finished result. The renderer focuses a pane already showing
    // the list rather than making a second one, so a docked Tasks editor never becomes a popup.
    ctx.host.ui({ type: 'view', action: 'open', editor: 'tasklist', where: 'popup' }, ctx.origin);

    const result = await ctx.host.session.runPipeline(mock);
    const what = mock
      ? `${result.preview.pendingTasks} pending task(s) previewed`
      : `${result.ran} task(s) ran`;
    // Counted from the plan, so a failure inherited from an earlier run still shows. Counting only
    // this run's own failures reported a clean run over art that does not exist.
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
    // An approve-and-generate pass is stopped by the same button, and reaching it is the point of
    // holding the session for the whole pass: a stop asked for between rounds ends the pass rather
    // than only the round it interrupted.
    if (busy !== BUSY_RUN && busy !== BUSY_PASS) {
      return Promise.resolve({ ok: false, reason: 'No pipeline run is in progress.' });
    }
    return Promise.resolve({ ok: true, note: stopsWhat(busy) });
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
 * back. A ceiling rather than a target: each round unlocks the next rung of the slot graph
 * (portrait, then sheet, then plate, then shot), so a project still going after this many rounds
 * has something wrong in it, and an unbounded loop would spend real image calls discovering that.
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
 * Split out and pinned by tests because every branch either spends more real image calls or stops
 * short of finishing the art, and an author only finds out which afterwards.
 */
/** Why the pass ended when the author pressed Stop, wherever in a round the stop landed. */
const STOPPED = 'stopped on request';

export function stopReason(outcome: RoundOutcome, round: number, cap = MAX_ROUNDS): string {
  if (outcome.stopped) return STOPPED;
  // Convergence: nothing was waiting to be approved and the planner had nothing left to do. A
  // project whose remaining tasks are failed or flagged `needs_human` has also stopped moving, so
  // that case gets its own sentence instead of being reported as everything generated.
  if (outcome.approved === 0 && outcome.ran === 0) {
    return outcome.failed > 0
      ? 'nothing left to approve, and what remains needs a person'
      : 'everything is generated and approved';
  }
  // A round that approved nothing and failed everything it tried will do the same again. Terminal
  // tasks are retried once by the scheduler, so this is the failure that has already been retried.
  if (outcome.approved === 0 && outcome.ran > 0 && outcome.failed >= outcome.ran) {
    return 'every task in the last round failed';
  }
  if (round + 1 >= cap) return `stopped after ${cap} rounds`;
  return '';
}

/**
 * The rows to approve this round: every unblocked candidate for a slot nothing has settled yet, and
 * at most one per slot.
 *
 * Both halves are the same rule, and both are about a slot's candidates being alternatives rather
 * than separate pictures. Approving a second portrait of Aiko is not approving two things, it is
 * choosing her look and then changing it; accepting a second sheet for one angle leaves `pick`
 * unable to say which one the slot holds, so the slot reads as empty and its plates re-render.
 * A settled slot is skipped outright — its losing takes stay listed for an author who wants to
 * choose one, but a pass that approved them would un-approve its own last round and never
 * converge. The first row of a slot is the one taken, because `approvable` already lists
 * upstream-first in slot order, which is the natural order to prefer.
 */
export function toApprove(items: readonly Approvable[]): Approvable[] {
  const chosen: Approvable[] = [];
  const taken = new Set<string>();
  for (const item of items) {
    if (item.blocked || item.settled) continue;
    // A portrait with no character clears nobody from the gate, which is the sentence `approveOne`
    // refuses with. Skipping it here keeps the loop from asking about it again every round.
    if (item.door === 'gate' && !item.characterId) continue;
    // Keyed by the slot the row is listed under, which for a portrait is the character's own.
    if (taken.has(item.slot)) continue;
    taken.add(item.slot);
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
  // Every step is undoable on its own; the pass as a whole is not.
  confirm: true,
  props: {},
  async check(_props, ctx) {
    const busy = ctx.host.session.busy();
    if (busy) return { ok: false, reason: `${busy} is already in progress.` };
    const state = await ctx.host.session.runPreconditions(false);
    if (state.keyError) return { ok: false, reason: state.keyError };
    const waiting = toApprove(await ctx.host.session.approvable()).length;
    const lines = [
      `${waiting} picture(s) would be approved, then ${state.pending} planned task(s) run.`,
    ];
    // A project with nothing waiting and nothing plannable ends after one round. The check says so
    // beforehand, because otherwise that round reads as a pass that ran and did nothing.
    if (waiting === 0 && state.pending === 0) {
      lines.push(
        'Nothing is waiting and nothing is plannable, so this ends after one round. Art that ' +
          'failed or is flagged for a person is not re-run by it.',
      );
    } else {
      lines.push(
        `Each round unlocks more, and it repeats until nothing is left — up to ${MAX_ROUNDS} rounds.`,
        'This spends real model calls.',
      );
    }
    return { ok: true, note: lines.join('\n') };
  },
  async run(_props, ctx) {
    // Same reasoning as `pipeline.run`, and more so: the list fills in while this happens, and it
    // happens for a while. Opened before the first await, so it is visible throughout the pass.
    ctx.host.ui({ type: 'view', action: 'open', editor: 'tasklist', where: 'popup' }, ctx.origin);

    let approved = 0;
    let ran = 0;
    let failed = 0;
    let rounds = 0;
    let why = `stopped after ${MAX_ROUNDS} rounds`;

    // The session is held for the whole pass rather than for each round's run, so Stop reaches the
    // gaps between rounds. Approving is not a run, and a stop asked for during one used to have
    // nothing to abort and was forgotten by the time the next round started.
    await ctx.host.session.duringPass(async (signal) => {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        rounds = round + 1;
        let approvedNow = 0;
        for (const item of toApprove(await ctx.host.session.approvable())) {
          if (signal.aborted) break;
          const outcome = await ctx.host.session.approveOne(item);
          // A refusal does not abandon the pass: the rows are re-derived every round, so whatever
          // refused is either already handled or listed again next time with its own sentence.
          if (outcome.ok) approvedNow++;
        }
        approved += approvedNow;

        // Checked ahead of the run so a stop costs nothing more. The run would report the same,
        // but only after loading the project and planning against it to be told to stop.
        if (signal.aborted) {
          why = STOPPED;
          break;
        }

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
    });

    const trouble = failed > 0 ? `, ${failed} failed` : '';
    return {
      message: `${approved} approved, ${ran} task(s) ran over ${rounds} round(s)${trouble} — ${why}.`,
      data: { approved, ran, failed, rounds, why },
      written: ['vngen/build/', 'vngen/state/tasks.jsonl', 'vngen/build/manifest.json'],
    };
  },
});
