/**
 * The debug conversation the report pane draws.
 *
 * Mirrors `agent.ts`: one module-level value, a revision the pane compares against, and an
 * installer called once at boot. Reducing is in `../rules/reportconvo.ts`, which is testable
 * because it reaches nothing that touches `window`.
 *
 * The accessors are named for the conversation rather than for the report because `bridge.ts`
 * already exports a `report`, which folds a command outcome into the status strip.
 */
import { threadDetail, threadLabel, type ThreadHeader } from '../../../src/shared/convo.js';
import { analysisEffort } from '../../../src/shared/advice.js';
import { api } from '../../api.js';
import {
  emptyReport,
  fromState,
  reduceRow,
  type ReportConvo,
  type ReportSetup,
} from '../../rules/reportconvo.js';
import { asked, answered } from '../../../src/shared/convo.js';
import { exec, onExec, say, shell } from '../app/bridge.js';
import type { ReportStateView } from '../../../src/shared/ipc.js';

let state: ReportConvo = emptyReport();
let rev = 0;

export function reportConvo(): ReportConvo {
  return state;
}

export function reportRevision(): number {
  return rev;
}

function set(next: ReportConvo): void {
  state = next;
  rev++;
}

/** Extra facts an automatic opening carries that an opening from the menu does not. */
export interface ReportSeed {
  /** The conversation the trouble happened in. Ignored if the project no longer has it. */
  thread?: string;
  /** Whether to tick the box for reading the source. */
  source?: boolean;
  /** Whether to tick the box for reading the requests this session sent. */
  detail?: boolean;
  /** One sentence saying why the pane opened by itself. */
  note?: string;
}

/** One row of the setup card. `thread` is chosen from `state.threads`. */
export function setSetup(patch: Partial<ReportSetup>): void {
  set({ ...state, setup: { ...state.setup, ...patch } });
}

/** A conversation for the setup card's menu, labelled the way the thread list labels it. */
export function threadRow(thread: ThreadHeader): { label: string; tooltip: string } {
  return { label: threadLabel(thread), tooltip: threadDetail(thread) };
}

/**
 * Fill in the setup card and open the pane.
 *
 * The default conversation is the newest rather than the active one. `Session.thread` is set
 * lazily on the first turn and cleared by `agent.clear`, by a new conversation, by an upload and by
 * reopening a thread, so there is usually no active conversation, including right after someone
 * reopened the bad conversation to look at it.
 *
 * `seed` is for an opening the author did not ask for, such as an API refusal the app offered to
 * look into. That opening knows which conversation it was and that the request itself is the
 * evidence, so it names the thread and ticks both reading boxes. The author still decides whether
 * to start it, and can untick either box.
 */
export async function seedReport(seed: ReportSeed = {}): Promise<void> {
  const outcome = await exec('agent.threads');
  if (!outcome.ok) {
    say('Could not read this project’s conversations.', true);
    return;
  }

  const { threads } = outcome.data as { threads: ThreadHeader[]; active?: string };
  if (threads.length === 0) {
    say('No conversations have been recorded in this project yet.', true);
    return;
  }

  const ui = shell().ui;
  const model = ui.model;
  // The bound effort, stepped up to where a diagnosis starts. Empty when the model has no effort
  // setting, which is also what makes the effort menu draw nothing
  const effort = analysisEffort(model, ui.effort) ?? '';

  // A seeded conversation only counts if the project still has it: a conversation can be deleted
  // between the failure and the pane opening, and a row nothing matches would leave the card blank.
  const seeded = seed.thread && threads.some((t) => t.id === seed.thread) ? seed.thread : undefined;

  set({
    ...state,
    threads,
    note : seed.note ?? '',
    setup: {
      thread: seeded ?? threads[0]?.id ?? '',
      model,
      effort,
      source: seed.source ?? state.setup.source,
      detail: seed.detail ?? state.setup.detail,
    },
  });

  await exec('view.open', { editor: 'report', where: 'popup' });
}

/** Start the analyst on what the setup card holds. */
export async function startReport(): Promise<ReportStateView | undefined> {
  const outcome = await exec('report.open', { ...state.setup, note: '' });
  return outcome.ok ? (outcome.data as ReportStateView) : undefined;
}

/**
 * Say one more thing to the analyst.
 *
 * The turn is shown before it is sent so the pane does not sit blank while a model thinks. A
 * successful turn needs no answer here: `exec` notifies its watchers before it resolves, so the
 * `report.say` outcome has already been folded by the time this line runs.
 */
export async function sayToReport(text: string): Promise<void> {
  const input = text.trim();
  if (!input || state.convo.busy) return;
  set({ ...state, convo: asked(state.convo, input) });
  const outcome = await exec('report.say', { text: input });
  if (!outcome.ok) set({ ...state, convo: answered(state.convo, null) });
}

/** The commands that answer with the whole conversation, so the pane redraws from one place. */
const STATE_COMMANDS = new Set(['report.grant', 'report.open', 'report.say', 'report.state']);

export function installReportConvo(): void {
  api.on('report:event', (event) => set(reduceRow(state, { kind: 'event', event })));
  onExec((id, outcome) => {
    if (!outcome.ok || !STATE_COMMANDS.has(id)) return;
    const view = outcome.data as ReportStateView | undefined;
    if (view?.rows) set(fromState(state, view));
  });
}
