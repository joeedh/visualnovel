/**
 * Opening the difficult-agent report on a command dialog.
 *
 * This is a function rather than a bare `openCommandDialog` in the menu because three of the five
 * fields have a vocabulary the command cannot carry: the conversations in this project, the models
 * a key might be set for, and the efforts the chosen model offers. All three are per-open choice
 * rows, and the efforts depend on the chosen model, so `choices` takes the current values rather
 * than a fixed map.
 */
import { TEXT_MODELS, effortChoicesFor, effortLabel } from '@vn/types';
import { threadDetail, threadLabel, type ThreadHeader } from '../../src/shared/convo.js';
import { adviseModel, analysisEffort } from '../../src/shared/advice.js';
import { openCommandDialog } from './dialog.js';
import type { ChoiceRow } from './commandform.js';
import { exec, onExec, say, shell } from './bridge.js';
import { openReportPreview, type ReportDraft } from './reportpreview.js';

/** Extra facts an automatic opening carries that an opening from the menu does not. */
export interface ReportSeed {
  /** The conversation the trouble happened in. Ignored if the project no longer has it. */
  thread?: string;
  /** Whether to tick the box for reading the source. */
  source?: boolean;
  /** Whether to tick the box for reading the requests this session sent. */
  detail?: boolean;
  /** One sentence saying why the dialog opened by itself. */
  note?: string;
}

/**
 * Open the preview whenever a report finishes, whichever part of the shell asked for one.
 *
 * Bound to the command rather than to the dialog's button, so the palette running the same id gets
 * the same preview. Called once, at boot, after the bridge.
 *
 * A report run through `window.vn.exec` is not covered. The scripting bridge lives in the preload
 * and invokes main directly, so no watcher here sees it; a report run from CDP is read off the
 * outcome and off the copy under `userData/reports/`.
 */
export function installReportPreview(): void {
  onExec((id, outcome) => {
    if (id !== 'report.agent' || !outcome.ok) return;
    const draft = outcome.data as ReportDraft | undefined;
    if (draft?.body) openReportPreview(draft);
  });
}

/**
 * Ask main for the conversations, then open the form seeded with the newest one.
 *
 * The default is the newest conversation rather than the active one. `Session.thread` is set
 * lazily on the first turn and cleared by `agent.clear`, by a new conversation, by an upload and by
 * reopening a thread, so there is usually no active conversation (including right after someone
 * reopened the bad conversation to look at it). Newest-first ordering makes the first row the
 * conversation the author had trouble with.
 *
 * `seed` is for an opening the author did not ask for, such as an API refusal the app offered to
 * look into. That opening knows which conversation it was and that the request itself is the
 * evidence, so it names the thread and ticks both reading boxes. The author still decides whether
 * to run it, and can untick either box.
 */
export async function openReportDialog(seed: ReportSeed = {}): Promise<void> {
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

  const rows: ChoiceRow[] = threads.map((thread) => ({
    value: thread.id,
    label: threadLabel(thread),
    tooltip: threadDetail(thread),
  }));

  const ui = shell().ui;
  const model = ui.model;
  // The bound effort, stepped up to where a diagnosis starts. Empty when the model has no effort
  // setting, which is also what makes the effort menu draw nothing
  const effort = analysisEffort(model, ui.effort) ?? '';

  // A seeded thread only counts if the project still has it: a conversation can be deleted
  // between the failure and the dialog, and a row nothing matches would leave the form blank.
  const seeded = seed.thread && threads.some((t) => t.id === seed.thread) ? seed.thread : undefined;

  openCommandDialog(
    'report.agent',
    {
      thread: seeded ?? threads[0]?.id ?? '',
      model,
      effort,
      ...(seed.source === undefined ? {} : { source: seed.source }),
      ...(seed.detail === undefined ? {} : { detail: seed.detail }),
    },
    (values) => ({
      thread: rows,
      model: modelRows(Boolean(values['source'])),
      effort: effortRows(String(values['model'] ?? model)),
    }),
    seed.note,
  );
}

/**
 * Every model, each carrying its advice as the row's own tooltip, so what a choice will cost is
 * readable before it is made rather than only afterwards in the verdict strip. The advice sharpens
 * when the source box is ticked, which is why the flag reaches this far.
 */
function modelRows(withSource: boolean): ChoiceRow[] {
  return TEXT_MODELS.map((id) => {
    const advice = adviseModel(id, withSource);
    return {
      value: id,
      label: id,
      tooltip: advice.text || `Read the conversation with ${id}.`,
    };
  });
}

/** Only what this model takes. Empty means it has no reasoning setting, and no menu is drawn. */
function effortRows(modelId: string): ChoiceRow[] {
  return effortChoicesFor(modelId).map((choice) => ({
    value: choice,
    label: effortLabel(choice),
    tooltip: `Ask ${modelId} to think ${effortLabel(choice)} about what went wrong.`,
  }));
}
