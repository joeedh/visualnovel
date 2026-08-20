import type { Diagnostic } from '@vn/types';
import type { FrontMatterDoc } from './frontmatter.js';

/**
 * One `scenes/<id>.md` as read from disk. The id is the filename stem, carried alongside
 * the doc because the front-matter `scene:` key has to agree with it — a mismatch is an error
 * naming both rather than one of the two silently winning.
 */
export interface SceneChunkDoc {
  id: string;
  /** Absolute path, for diagnostics and for the writer that patches this same file. */
  file: string;
  doc: FrontMatterDoc;
  /**
   * The file's bytes as read. A prose patcher rewrites `doc.body` and splices it back under
   * the front-matter block `splitFrontMatter` takes off this text, so the author's YAML is
   * never re-serialized — and it patches exactly the bytes the model was built from.
   */
  text: string;
}

/**
 * One discovered character or location sheet, in the same shape as {@link SceneChunkDoc} and for
 * the same reason: a consumer that holds the doc holds the file it came out of. Entities are
 * found by their `type:` tag rather than by path, so the file is the only answer to "where does
 * this live" — re-deriving one from the id names a path that may not exist.
 */
export interface EntityDoc {
  /**
   * The id the file's own name implies — its parent directory for `characters/<id>/character.md`,
   * its filename stem everywhere else. Front-matter `id:` remains the authority and must agree
   * with this; a mismatch is an error naming both, never one of the two silently winning.
   */
  id: string;
  /** Absolute path, for diagnostics and for the writer that patches this same file. */
  file: string;
  doc: FrontMatterDoc;
  /** The file's bytes as read, so a front-matter patcher can splice byte-exactly. */
  text: string;
}

/**
 * The authored documents a project loads to. This shape is declared here, in the package that
 * owns the document types, because the reader (`@vn/store`) and the model builder (`@vn/model`)
 * sit side by side in the layering graph and neither may import the other.
 */
export interface LoadedInputs {
  characterDocs: EntityDoc[];
  locationDocs: EntityDoc[];
  /** Every scene a project has. `scenes/<id>.md` is the only form scenes are read from. */
  sceneDocs: SceneChunkDoc[];
  /**
   * A retired one-file `screenplay/` script sitting in the project, if there is one. This is not
   * an input: the reader reports it as a diagnostic naming `vngen import` rather than building
   * scenes from it. Carried as the absolute path so the importer converts the same file the
   * reader complained about, instead of re-deciding which one is the screenplay.
   */
  legacyScreenplay?: string;
  /**
   * Problems found while reading, carried into the model's diagnostics rather than thrown —
   * the reader has no way to report, and every other input problem is a diagnostic too.
   */
  diagnostics: Diagnostic[];
}
