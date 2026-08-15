/**
 * Entity discovery — which files on disk are character and set-location sheets.
 *
 * Discovery is by the `type:` tag in front-matter, not by path: an author who files a character
 * under `wiki/cast/ada.md` has written a character, not a file nothing reads. Three surfaces and
 * no more — `characters/`, `locations/`, and a walk of `wiki/**` — because discovery everywhere
 * would make every stray markdown file a potential entity and would put the cost of the walk on
 * every load.
 *
 * Turning a doc into a `Character`/`Location` is `@vn/model`'s job, as it is for scene chunks:
 * this module decides *which files*, and says out loud when two of them claim the same identity.
 */
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontMatter, type EntityDoc } from '@vn/parse';
import { ENTITY_TAG_KEY, ENTITY_TAGS, type Diagnostic, type EntityTag } from '@vn/types';
import { exists, readText } from '@vn/util';
import { taggedKind } from './docfile.js';
import type { ProjectPaths } from './paths.js';
import { listWikiFiles } from './tree.js';

/** A discovered sheet, with the surface it came from — which is what breaks a duplicate tie. */
interface Candidate {
  kind: EntityTag;
  doc: EntityDoc;
  /** True for `characters/`/`locations/`, which win over the wiki when both claim an id. */
  conventional: boolean;
}

/**
 * Read one sheet: bytes, front-matter, and the id the file's own name implies. Unparseable YAML
 * is a diagnostic naming the file rather than a thrown error — one hand-edited sheet must not
 * take the whole project's load down with it.
 */
async function readCandidate(
  file: string,
  id: string,
  diagnostics: Diagnostic[],
  severity: 'error' | 'warning',
): Promise<EntityDoc | undefined> {
  const text = await readText(file);
  try {
    return { id, file, doc: parseFrontMatter(text), text };
  } catch (err) {
    diagnostics.push({
      severity,
      code: 'entity_file',
      message: `${file} has unparseable front-matter: ${(err as Error).message}`,
      where: id,
    });
    return undefined;
  }
}

/**
 * A conventional sheet's tag comes from its directory. Stating the *other* kind there is a
 * conflict rather than an override: moving a file is how a document changes kind, and honouring
 * the tag would make `locations/` hold a character while every location path still named it.
 */
function tagConflict(doc: EntityDoc, kind: EntityTag, diagnostics: Diagnostic[]): boolean {
  const stated = taggedKind(doc.doc.data);
  if (stated === undefined || stated === kind) return false;
  diagnostics.push({
    severity: 'error',
    code: 'entity_tag_conflict',
    message: `${doc.file} is a ${kind} by its location but declares ${ENTITY_TAG_KEY}: ${stated}; move the file or fix the tag`,
    where: doc.id,
  });
  return true;
}

/** `characters/<id>/character.md` — the id is the directory name. */
async function fromCharactersDir(
  paths: ProjectPaths,
  diagnostics: Diagnostic[],
): Promise<Candidate[]> {
  if (!(await exists(paths.charactersDir))) return [];
  const entries = await fs.readdir(paths.charactersDir, { withFileTypes: true });
  const found: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = paths.characterFile(entry.name);
    if (!(await exists(file))) continue;
    const doc = await readCandidate(file, entry.name, diagnostics, 'error');
    if (!doc || tagConflict(doc, ENTITY_TAGS.character, diagnostics)) continue;
    found.push({ kind: ENTITY_TAGS.character, doc, conventional: true });
  }
  return found;
}

/** `locations/<id>.md` — the id is the filename stem. */
async function fromLocationsDir(
  paths: ProjectPaths,
  diagnostics: Diagnostic[],
): Promise<Candidate[]> {
  if (!(await exists(paths.locationsDir))) return [];
  const entries = await fs.readdir(paths.locationsDir, { withFileTypes: true });
  const found: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const id = entry.name.slice(0, -'.md'.length);
    const doc = await readCandidate(join(paths.locationsDir, entry.name), id, diagnostics, 'error');
    if (!doc || tagConflict(doc, ENTITY_TAGS.location, diagnostics)) continue;
    found.push({ kind: ENTITY_TAGS.location, doc, conventional: true });
  }
  return found;
}

/** `wiki/**\/*.md` carrying an entity tag — the id is the filename stem. Untagged files are not
 * inputs; they are the story bible's own business and are passed over in silence. */
async function fromWiki(paths: ProjectPaths, diagnostics: Diagnostic[]): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const file of await listWikiFiles(paths)) {
    const id = basename(file).slice(0, -'.md'.length);
    const doc = await readCandidate(file, id, diagnostics, 'warning');
    if (!doc) continue;
    const kind = taggedKind(doc.doc.data);
    if (kind === undefined) continue;
    found.push({ kind, doc, conventional: false });
  }
  return found;
}

/**
 * One doc per id, ordered by id. Two files claiming the same identity is never silent and never a
 * guess: the conventional directory wins over the wiki, wiki ties go to the lexicographically
 * first path, and the losing file is named in a warning so the author can delete the copy they
 * did not mean to keep.
 */
function dedupe(candidates: Candidate[], kind: EntityTag, diagnostics: Diagnostic[]): EntityDoc[] {
  const byId = new Map<string, Candidate[]>();
  for (const candidate of candidates.filter((c) => c.kind === kind)) {
    const list = byId.get(candidate.doc.id);
    if (list) list.push(candidate);
    else byId.set(candidate.doc.id, [candidate]);
  }

  const docs: EntityDoc[] = [];
  for (const id of [...byId.keys()].sort()) {
    const tied = byId.get(id)!.sort((a, b) => {
      if (a.conventional !== b.conventional) return a.conventional ? -1 : 1;
      return a.doc.file < b.doc.file ? -1 : a.doc.file > b.doc.file ? 1 : 0;
    });
    const [winner, ...losers] = tied;
    for (const loser of losers) {
      diagnostics.push({
        severity: 'warning',
        code: 'duplicate_entity',
        message: `${kind} "${id}" is claimed by both ${winner!.doc.file} and ${loser.doc.file}; the first is used`,
        where: id,
      });
    }
    docs.push(winner!.doc);
  }
  return docs;
}

/**
 * The file a discovered entity lives in, or undefined when no sheet claims that id. The one way
 * to answer "where is this character" — a caller holding `LoadedInputs` asks here rather than
 * building a path out of the id.
 */
export function entityFile(docs: EntityDoc[], id: string): string | undefined {
  return entityDoc(docs, id)?.file;
}

/**
 * The whole discovered sheet, for a writer that patches front-matter rather than replacing the
 * file. Same lookup as {@link entityFile}, so a writer and a reporter can never disagree about
 * which of two files claiming an id they mean.
 */
export function entityDoc(docs: EntityDoc[], id: string): EntityDoc | undefined {
  return docs.find((d) => d.id === id);
}

/** Every character and set-location sheet a project has, across all three surfaces. */
export async function discoverEntities(
  paths: ProjectPaths,
  diagnostics: Diagnostic[],
): Promise<{ characterDocs: EntityDoc[]; locationDocs: EntityDoc[] }> {
  const candidates = [
    ...(await fromCharactersDir(paths, diagnostics)),
    ...(await fromLocationsDir(paths, diagnostics)),
    ...(await fromWiki(paths, diagnostics)),
  ];
  return {
    characterDocs: dedupe(candidates, ENTITY_TAGS.character, diagnostics),
    locationDocs: dedupe(candidates, ENTITY_TAGS.location, diagnostics),
  };
}
