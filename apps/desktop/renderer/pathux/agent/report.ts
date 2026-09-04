/**
 * The preview a finished report opens. The setup card's own model and effort menus are built from
 * `rules/vocabulary.ts`, which the command palette reads for the same two props.
 */
import { onExec } from '../app/bridge.js';
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
