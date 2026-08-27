/**
 * Entity discovery — which files on disk are character and set-location sheets.
 *
 * Discovery is by the `type:` tag in front-matter rather than by path, so a character filed under
 * `wiki/cast/ada.md` is still discovered. Only three surfaces are searched — `characters/`,
 * `locations/`, and a walk of `wiki/**` — because searching everywhere would make every stray
 * markdown file a potential entity and would put the cost of that walk on every load.
 *
 * Turning a doc into a `Character`/`Location` is `@vn/model`'s job, as it is for scene chunks.
 * This module decides which files qualify, and reports a diagnostic when two of them claim the
 * same identity.
 */
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontMatter, type EntityDoc } from '@vn/parse';
import { ENTITY_TAG_KEY, ENTITY_TAGS, type Diagnostic, type EntityTag } from '@vn/types';
import { exists, pool, readText } from '@vn/util';
import { READ_CONCURRENCY, taggedKind } from './docfile.js';
import type { ProjectPaths } from './paths.js';
import { listWikiFiles } from './tree.js';

/** A discovered sheet, with the surface it came from, which breaks a duplicate tie. */
interface Candidate {
  kind: EntityTag;
  doc: EntityDoc;
  /** True for `characters/`/`locations/`, which win over the wiki when both claim an id. */
  conventional: boolean;
}

/**
 * Read one sheet: bytes, front-matter, and the id the file's own name implies. Unparseable YAML
 * produces a diagnostic naming the file rather than a thrown error, so one hand-edited sheet does
 * not fail the whole project's load.
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
 * A conventional sheet's tag comes from its directory. Stating the opposite kind there is a
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

/**
 * Read every sheet at once and merge what comes back in the order the files were in.
 *
 * Each read gets its own diagnostics array rather than sharing one, because appending to a shared
 * array from concurrent reads would order a load's diagnostics by whichever read finished first.
 * A project's diagnostics have to be the same list every time it is loaded.
 */
async function readAll<T>(
  items: readonly T[],
  diagnostics: Diagnostic[],
  read: (item: T, into: Diagnostic[]) => Promise<Candidate | undefined>,
): Promise<Candidate[]> {
  const done = await pool(items, READ_CONCURRENCY, async (item) => {
    const into: Diagnostic[] = [];
    return { into, candidate: await read(item, into) };
  });

  const found: Candidate[] = [];
  for (const { into, candidate } of done) {
    diagnostics.push(...into);
    if (candidate) found.push(candidate);
  }
  return found;
}

/** `characters/<id>/character.md` — the id is the directory name. */
async function fromCharactersDir(
  paths: ProjectPaths,
  diagnostics: Diagnostic[],
): Promise<Candidate[]> {
  if (!(await exists(paths.charactersDir))) return [];
  const entries = await fs.readdir(paths.charactersDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());

  return readAll(dirs, diagnostics, async (entry, into) => {
    const file = paths.characterFile(entry.name);
    if (!(await exists(file))) return undefined;
    const doc = await readCandidate(file, entry.name, into, 'error');
    if (!doc || tagConflict(doc, ENTITY_TAGS.character, into)) return undefined;
    return { kind: ENTITY_TAGS.character, doc, conventional: true };
  });
}

/** `locations/<id>.md` — the id is the filename stem. */
async function fromLocationsDir(
  paths: ProjectPaths,
  diagnostics: Diagnostic[],
): Promise<Candidate[]> {
  if (!(await exists(paths.locationsDir))) return [];
  const entries = await fs.readdir(paths.locationsDir, { withFileTypes: true });
  const sheets = entries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'),
  );

  return readAll(sheets, diagnostics, async (entry, into) => {
    const id = entry.name.slice(0, -'.md'.length);
    const doc = await readCandidate(join(paths.locationsDir, entry.name), id, into, 'error');
    if (!doc || tagConflict(doc, ENTITY_TAGS.location, into)) return undefined;
    return { kind: ENTITY_TAGS.location, doc, conventional: true };
  });
}

/** `wiki/**\/*.md` carrying an entity tag — the id is the filename stem. Untagged files are not
 * inputs; they belong to the story bible and are skipped without a diagnostic. */
async function fromWiki(paths: ProjectPaths, diagnostics: Diagnostic[]): Promise<Candidate[]> {
  const files = await listWikiFiles(paths);

  return readAll(files, diagnostics, async (file, into) => {
    const id = basename(file).slice(0, -'.md'.length);
    const doc = await readCandidate(file, id, into, 'warning');
    if (!doc) return undefined;
    const kind = taggedKind(doc.doc.data);
    if (kind === undefined) return undefined;
    return { kind, doc, conventional: false };
  });
}

/**
 * One doc per id, ordered by id. When two files claim the same identity the conventional directory
 * wins over the wiki, wiki ties go to the lexicographically first path, and the losing file is
 * named in a warning so the author can delete the copy they did not mean to keep.
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
  // The three surfaces are walked together, each collecting its own diagnostics so the merged
  // list still reads conventional-first however the walks interleave.
  const surfaces: Diagnostic[][] = [[], [], []];
  const [characters, locations, wiki] = await Promise.all([
    fromCharactersDir(paths, surfaces[0]!),
    fromLocationsDir(paths, surfaces[1]!),
    fromWiki(paths, surfaces[2]!),
  ]);
  for (const found of surfaces) diagnostics.push(...found);

  const candidates = [...characters, ...locations, ...wiki];
  return {
    characterDocs: dedupe(candidates, ENTITY_TAGS.character, diagnostics),
    locationDocs: dedupe(candidates, ENTITY_TAGS.location, diagnostics),
  };
}
