import type {
  AssetRef,
  DefectReport,
  ReviewRef,
  ShotSpec,
  TaskLogImage,
  VisionReviewer,
} from '@vn/types';
import { defectReportSchema } from '@vn/types';
import { sha256 } from '@vn/util';
import type { ChatBackend, RefLoader } from './backend.js';
import { RequestStopped } from './requests.js';
import { parseStructured, withStructuredRetry } from './structured.js';
import { noteReview, noteTask, withTaskLogScope } from './tasklog.js';

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

/** Model replies one review may spend before its malformed output fails the review. */
const REVIEW_TRIES = 3;

/** An image as the task log names it: by store hash, or by the hash of bytes never stored. */
function imageNote(ref: ReviewRef): TaskLogImage {
  return 'bytes' in ref
    ? { hash: sha256(ref.bytes), ext: ref.ext, inline: true }
    : { hash: ref.hash };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Logs a reply that will not parse, which `withStructuredRetry` is about to retry past. */
function noteUnparsed(raw: string, n: number): void {
  try {
    parseStructured(raw, defectReportSchema);
  } catch (err) {
    const level = n < REVIEW_TRIES ? 'retry' : 'error';
    noteTask(level, `reply ${n} of ${REVIEW_TRIES} did not parse: ${errorText(err)}`);
  }
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

  review(image: AssetRef, spec: ShotSpec, refs: readonly ReviewRef[]): Promise<DefectReport> {
    return withTaskLogScope({ source: `reviewer:${this.id}` }, () =>
      this.reviewLogged(image, spec, refs),
    );
  }

  /** Reviews once, writing the whole exchange to the task log whether or not it succeeds. */
  private async reviewLogged(
    image: AssetRef,
    spec: ShotSpec,
    refs: readonly ReviewRef[],
  ): Promise<DefectReport> {
    const started = Date.now();
    const system = reviewSystem(spec);
    const prompt = [
      'SHOT SPECIFICATION:',
      JSON.stringify(spec, null, 2),
      '',
      'The first image is the generated result; any following images are references.',
      'Report all defects as JSON.',
    ].join('\n');
    const responses: string[] = [];
    const transcript = (error?: unknown): void =>
      noteReview({
        t         : 'review',
        reviewer  : this.id,
        model     : this.backend.modelId,
        systemText: system,
        prompt,
        images: [image, ...refs].map(imageNote),
        responses,
        ...(error === undefined ? {} : { error: errorText(error) }),
        ms: Date.now() - started,
      });

    const ask = async () => {
      const images = await Promise.all(
        [image, ...refs].map((r) => ('bytes' in r ? Promise.resolve(r) : this.loadRef(r))),
      );
      return withStructuredRetry(
        defectReportSchema,
        async () => {
          const raw = await this.backend.message({ system, prompt, images });
          responses.push(raw);
          noteUnparsed(raw, responses.length);
          return raw;
        },
        { attempts: REVIEW_TRIES },
      );
    };
    const report = await ask().catch((err: unknown) => {
      // A stop before any reply is not a review that happened
      if (!(err instanceof RequestStopped) || responses.length > 0) transcript(err);
      throw err;
    });
    transcript();
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
