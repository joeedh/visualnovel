/**
 * Opening the difficult-agent report on a command dialog.
 *
 * It is a function rather than a bare `openCommandDialog` in the menu because three of the four
 * fields have a vocabulary the command cannot carry: the conversations in *this* project, the
 * models a key might be set for, and the efforts the chosen model offers. All three are per-open
 * choice rows, and the last is a function of the first — which is why `choices` takes the current
 * values rather than a fixed map.
 */
import { TEXT_MODELS, effortChoicesFor, effortLabel } from '@vn/types';
import { threadDetail, threadLabel, type ThreadHeader } from '../../src/shared/convo.js';
import { adviseModel, analysisEffort } from '../../src/shared/advice.js';
import { openCommandDialog } from './dialog.js';
import type { ChoiceRow } from './commandform.js';
import { exec, onExec, say, shell } from './bridge.js';
import { openReportPreview, type ReportDraft } from './reportpreview.js';

/**
 * Open the preview whenever a report finishes, whoever asked for one.
 *
 * Bound to the *command* rather than to the dialog's button: the palette and CDP run the same id,
 * and a minute of a real model's time answering into nothing would be a minute paid for twice.
 * Called once, at boot, after the bridge.
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
 * **The default is the newest, not the active one.** `Session.thread` is set lazily on the first
 * turn and cleared by `agent.clear`, a new conversation, an upload and by *reopening* a thread —
 * so there is usually no active one, including right after someone reopened the bad conversation
 * to look at it. Newest-first ordering makes the first row the one they had trouble with.
 */
export async function openReportDialog(): Promise<void> {
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
  // The bound effort, stepped up to where a diagnosis starts. Empty when the model has no knob,
  // which is also what makes the effort menu draw nothing at all.
  const effort = analysisEffort(model, ui.effort) ?? '';

  openCommandDialog('report.agent', { thread: threads[0]?.id ?? '', model, effort }, (values) => ({
    thread: rows,
    model: modelRows(Boolean(values['source'])),
    effort: effortRows(String(values['model'] ?? model)),
  }));
}

/**
 * Every model, each carrying its advice as the row's own tooltip — so what a choice will cost is
 * readable *before* it is made, rather than only afterwards in the verdict strip. The advice
 * sharpens when the source box is ticked, which is why the flag reaches this far.
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
