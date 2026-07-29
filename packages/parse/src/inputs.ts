import type { FrontMatterDoc } from './frontmatter.js';

/**
 * The authored documents a project loads to. It lives here, in the package that owns the
 * document types, because the reader (`@vn/store`) and the model builder (`@vn/model`) are
 * side by side in the layering graph and neither may import the other — one declaration is
 * what keeps them from drifting on the shape.
 */
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
