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
  'Respond ONLY with JSON: {"reviewer": string, "defects": [{"severity":',
  '"blocking"|"major"|"minor", "category": string, "description": string,',
  '"suggestedFix"?: string}]}. An empty defects array means the image is acceptable.',
].join(' ');

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
      this.backend.message({ system: REVIEW_SYSTEM, prompt, images }),
    );
    // Stamp the reviewer id so merged reports are attributable.
    return { reviewer: this.id, defects: report.defects ?? [] };
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
