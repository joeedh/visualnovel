import type { FrontMatterDoc } from './frontmatter.js';

/**
 * The authored documents a project loads to. It lives here, in the package that owns the
 * document types, because the reader (`@vn/store`) and the model builder (`@vn/model`) are
 * side by side in the layering graph and neither may import the other — one declaration is
 * what keeps them from drifting on the shape.
 */
/**
 * One `scenes/<id>.md` as read from disk. The id is the **filename stem**, carried alongside
 * the doc because the front-matter `scene:` key has to agree with it — a mismatch is an error
 * naming both rather than one of the two silently winning.
 */
export interface SceneChunkDoc {
  id: string;
  /** Absolute path, for diagnostics and for the writer that patches this same file. */
  file: string;
  doc: FrontMatterDoc;
}

export interface LoadedInputs {
  characterDocs: FrontMatterDoc[];
  locationDocs: FrontMatterDoc[];
  scriptText: string;
  /**
   * Absolute path `scriptText` was read from, or undefined when the project has no screenplay.
   * Returned so a writer (the desktop branch editor) patches the same file the model was built
   * from, instead of re-deriving "which file is the screenplay" and drifting from this rule.
   */
  scriptPath?: string;
}
