import type { AssetRef, DefectReport, ShotSpec, VisionReviewer } from '@vn/types';
import { defectReportSchema } from '@vn/types';
import type { ChatBackend, RefLoader } from './backend.js';
import { withStructuredRetry } from './structured.js';

const REVIEW_SYSTEM = [
  'You are a meticulous visual QA reviewer for a visual novel art pipeline.',
  'Compare the generated image against the shot specification and reference images.',
  'Check: correct character(s) present and recognizable; correct outfit; correct',
  'expression/pose; correct location and time of day; no extra/duplicate limbs or',
  'people; framing matches; text present only if intended.',
  "The spec's `characters` field is the authority on who belongs in frame: when it is",
  'empty the shot is a background plate and an absent character is not a defect. Names',
  'that appear only in the narrative context are setting, not a casting instruction.',
  'Respond ONLY with JSON: {"reviewer": string, "defects": [{"severity":',
  '"blocking"|"major"|"minor", "category": string, "description": string,',
  '"suggestedFix"?: string}]}. An empty defects array means the image is acceptable.',
].join(' ');

/**
 * Asked only of a page: the boxes are measured, not judged, and the runner draws the layout
 * verdict from them against the intended outlines, which the reviewer never sees.
 */
const PANEL_RULE = [
  'The spec carries `panels`, so the image is a comic page. Also measure it: add',
  '"observed": {"panels": [{"box": {"x", "y", "w", "h"}}]} to your JSON, one box per drawn',
  'panel border in reading order, each as fractions of the page from its top-left corner.',
  "Check each panel's framing and characters against its entry in `panels`.",
].join(' ');

/** Asked only when the image model was told to letter the page itself. */
const LETTERING_RULE = [
  'The spec carries `lettering`: the exact words each panel must show. Read every piece of',
  'text in the image and compare it, panel by panel. Text that is missing, misspelt, in the',
  'wrong panel, or that the spec does not list is a blocking defect in category "lettering".',
].join(' ');

/** The system prompt for one spec: the base rules, plus what a page and a lettered page add. */
function reviewSystem(spec: ShotSpec): string {
  return [
    REVIEW_SYSTEM,
    ...(spec.panels ? [PANEL_RULE] : []),
    ...(spec.lettering ? [LETTERING_RULE] : []),
  ].join(' ');
}

/**
 * A `VisionReviewer` over any vision-capable `ChatBackend` — both Gemini and Claude
 * implement this (report §P7). The critique is requested as structured JSON and
 * validated, so the refine step can act on it programmatically.
 */
export class ChatVisionReviewer implements VisionReviewer {
  readonly id: string;

  constructor(
    id: string,
    private readonly backend: ChatBackend,
    private readonly loadRef: RefLoader,
  ) {
    this.id = id;
  }

  async review(image: AssetRef, spec: ShotSpec, refs: AssetRef[]): Promise<DefectReport> {
    const images = await Promise.all([image, ...refs].map((r) => this.loadRef(r)));
    const prompt = [
      'SHOT SPECIFICATION:',
      JSON.stringify(spec, null, 2),
      '',
      'The first image is the generated result; any following images are references.',
      'Report all defects as JSON.',
    ].join('\n');

    const report = await withStructuredRetry(defectReportSchema, () =>
      this.backend.message({ system: reviewSystem(spec), prompt, images }),
    );
    // Stamp the reviewer id so merged reports are attributable.
    const stamped: DefectReport = { reviewer: this.id, defects: report.defects ?? [] };
    // Only what a page asked for: a frame's review never carries measurements
    if (spec.panels && report.observed) {
      stamped.observed = { panels: report.observed.panels ?? [] };
    }
    return stamped;
  }
}

/** Merge multiple reviewers' reports (report §P7: Gemini + Claude). */
export function mergeReports(reports: DefectReport[]): {
  defects: DefectReport['defects'];
  blocking: boolean;
} {
  const defects = reports.flatMap((r) => r.defects);
  const blocking = defects.some((d) => d.severity === 'blocking');
  return { defects, blocking };
}
