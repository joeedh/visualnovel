/**
 * The vocabulary the report's setup card offers, and the preview a finished report opens.
 *
 * The model and effort menus are built per open rather than declared on the command: an enum's
 * values are baked into the catalog at module load, while the efforts depend on the model chosen
 * in the same card and each model's advice depends on whether the source box is ticked.
 */
import { TEXT_MODELS, effortChoicesFor, effortLabel } from '@vn/types';
import { adviseModel } from '../../src/shared/advice.js';
import type { ChoiceRow } from './commandform.js';
import { onExec } from './bridge.js';
import { openReportPreview, type ReportDraft } from './reportpreview.js';

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
 * Every model, each carrying its advice as the row's own tooltip, so what a choice will cost is
 * readable before it is made rather than only afterwards in the verdict strip. The advice sharpens
 * when the source box is ticked, which is why the flag reaches this far.
 */
export function modelRows(withSource: boolean): ChoiceRow[] {
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
export function effortRows(modelId: string): ChoiceRow[] {
  return effortChoicesFor(modelId).map((choice) => ({
    value: choice,
    label: effortLabel(choice),
    tooltip: `Ask ${modelId} to think ${effortLabel(choice)} about what went wrong.`,
  }));
}
