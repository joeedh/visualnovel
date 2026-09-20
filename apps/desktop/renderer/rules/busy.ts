/**
 * What the header draws for each kind of long-running work: which command Stop runs, what Stop is
 * about to do, and what the spinner says is happening.
 *
 * Not every kind of work is in the table. An authoring turn is left out deliberately, because the
 * conversation editor owns that Stop button and a second one in the header would claim authority
 * over a turn the header knows nothing about. A kind that is not in the table draws no spinner and
 * no Stop, which is what the header did for everything but a pipeline run before this existed.
 */
import { BUSY_PASS, BUSY_REPORT, BUSY_RUN, stopsWhat } from '../../src/shared/ipc.js';

export interface BusyControls {
  /** The command the Stop button runs. */
  stop: string;
  /** What stopping is about to do, for the button's tooltip. */
  stops: string;
  /**
   * The tooltip for a second press of Stop, shown once a stop is already pending. Absent for
   * work with nothing in flight to cut off, where a second press repeats the first.
   */
  aborts?: string;
  /**
   * What the spinner says, from the counts main pushes alongside the busy state. `stopping` adds
   * that the end is already asked for.
   */
  progress(ran: number, pending: number, stopping?: boolean): string;
}

const PIPELINE: BusyControls = {
  stop    : 'pipeline.stop',
  stops   : stopsWhat(BUSY_RUN),
  aborts:
    'A stop is already pending: the run ends once the tasks in flight finish. Stopping again ' +
    'cuts those tasks off — each goes back to pending, and the model call it was in is ' +
    'abandoned, still paid for and its picture lost.',
  progress: (ran, pending, stopping = false) =>
    `The pipeline is running — ${ran} task(s) done, ` +
    `${pending} ${pending === 1 ? 'task' : 'tasks'} left.` +
    (stopping ? ' Stopping once the tasks in flight finish.' : ''),
};

/**
 * An approve-and-generate pass holds the session through the gaps between its rounds, so the
 * spinner and the button stay drawn there rather than blinking out while the pass approves.
 */
const PASS: BusyControls = { ...PIPELINE, stops: stopsWhat(BUSY_PASS) };

/**
 * A report counts the steps of one turn and never knows how many are left, so its sentence says
 * what has happened rather than what remains.
 */
const REPORT: BusyControls = {
  stop    : 'report.stop',
  stops   : 'The turn ends after the step it is on. What the debug agent has said is kept.',
  progress: (ran) => `The debug agent is reading — ${ran} step(s) so far.`,
};

/** The controls for the work in flight, or nothing where the header draws none. */
export function busyControls(busy: string): BusyControls | undefined {
  switch (busy) {
    case BUSY_RUN:
      return PIPELINE;
    case BUSY_PASS:
      return PASS;
    case BUSY_REPORT:
      return REPORT;
    default:
      return undefined;
  }
}
