/**
 * Provider-agnostic generative interfaces (report §8, §P6, §P7). The scheduler never
 * imports a concrete provider — it only knows Task/deps/status. Providers are swapped
 * via model ids in project.yaml.
 */
import type { AssetRef, ImageParams, PanelBox } from './entities.js';
import type { Transport } from './textmodels.js';

/** Result of an image generation or edit. */
export interface ImageResult {
  /** Raw image bytes. */
  bytes: Uint8Array;
  ext: string;
  /** The model as the caller named it, which is what the manifest and the dedupe key hold. */
  modelId: string;
  /** Seed actually used, when the provider reports one. */
  seed?: number;
  /** Which key carried the call, when the router knows. */
  transport?: Transport;
}

/** Generates and edits images (Gemini "nano banana" in practice). */
export interface ImageProvider {
  generate(prompt: string, refs: AssetRef[], params: ImageParams): Promise<ImageResult>;
  /** Reference-guided edit: variants, outfits, time-of-day re-lights. */
  edit(base: AssetRef, prompt: string, refs: AssetRef[], params: ImageParams): Promise<ImageResult>;
}

/** Severity of a defect found by a vision reviewer. */
export type DefectSeverity = 'blocking' | 'major' | 'minor';

/** A single defect in a structured critique (report §P7). */
export interface Defect {
  severity: DefectSeverity;
  category: string;
  description: string;
  /** Targeted prompt edit suggested to fix it. */
  suggestedFix?: string;
}

/** Structured critique of one generated image. */
export interface DefectReport {
  /** Who produced this review, e.g. `gemini` or `claude`. */
  reviewer: string;
  defects: Defect[];
  /**
   * What the reviewer measured in the image, present only when the spec asked for it: the
   * panel boxes it saw, in reading order. The layout verdict is drawn from these by the runner,
   * which holds the intended geometry.
   */
  observed?: { panels: { box: PanelBox }[] };
}

/** One panel of a page shot, in the words a reviewer reads. */
export interface PanelSpec {
  /** One-based, in reading order. */
  index: number;
  /** The panel's place on the page in words, derived from its outline. */
  shapeWords: string;
  framing: string;
  characters: string[];
}

/** What a shot is supposed to depict; handed to reviewers as the spec (report §P7). */
export interface ShotSpec {
  description: string;
  characters: string[];
  outfit?: string;
  location: string;
  expression?: string;
  framing?: string;
  /** Present on a page shot; the reviewer then reports the boxes it sees under `observed`. */
  panels?: PanelSpec[];
  /**
   * The words each panel should letter, present only when the image model was asked to draw
   * them. The reviewer reads the page's text against this and files a mismatch as blocking.
   */
  lettering?: { panel: number; lines: string[] }[];
}

/**
 * A picture handed to a reviewer beside the result: an asset the store holds, or bytes that
 * never entered it, such as the staging-sheet cell a bound graph drew a frame from.
 */
export type ReviewRef = AssetRef | { bytes: Uint8Array; ext: string };

/** Reads an image back and reports defects against the spec (Gemini and Claude). */
export interface VisionReviewer {
  /** Stable id, e.g. `gemini` or `claude`. */
  readonly id: string;
  review(image: AssetRef, spec: ShotSpec, refs: readonly ReviewRef[]): Promise<DefectReport>;
}

/** Text LLM for mining, decomposition, and prompt refinement (report §8). */
export interface TextLLM {
  /** Free-form completion. */
  complete(prompt: string, system?: string): Promise<string>;
  /**
   * Structured completion: the result is validated against `schema` (a parse fn that
   * throws on mismatch) with retries. Keeps machine-consumed output well-formed.
   */
  structured<T>(prompt: string, parse: (raw: string) => T, system?: string): Promise<T>;
}

/** Bundle of providers resolved from config and handed to the pipeline. */
export interface Providers {
  image: ImageProvider;
  reviewers: VisionReviewer[];
  text: TextLLM;
}
