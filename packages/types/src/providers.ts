/**
 * Provider-agnostic generative interfaces (report §8, §P6, §P7). The scheduler never
 * imports a concrete provider — it only knows Task/deps/status. Providers are swapped
 * via model ids in project.yaml.
 */
import type { AssetRef, ImageParams } from './entities.js';

/** Result of an image generation or edit. */
export interface ImageResult {
  /** Raw image bytes. */
  bytes: Uint8Array;
  ext: string;
  modelId: string;
  /** Seed actually used, when the provider reports one. */
  seed?: number;
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
}

/** What a shot is supposed to depict; handed to reviewers as the spec (report §P7). */
export interface ShotSpec {
  description: string;
  characters: string[];
  outfit?: string;
  location: string;
  expression?: string;
  framing?: string;
}

/** Reads an image back and reports defects vs. the spec (Gemini AND Claude). */
export interface VisionReviewer {
  /** Stable id, e.g. `gemini` or `claude`. */
  readonly id: string;
  review(image: AssetRef, spec: ShotSpec, refs: AssetRef[]): Promise<DefectReport>;
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
