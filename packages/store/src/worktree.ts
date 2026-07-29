import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  parseFrontMatter,
  stringifyFrontMatter,
  type FrontMatterDoc,
  type LoadedInputs,
} from '@vn/parse';
import { ensureDir, exists, writeFileAtomic } from '@vn/util';
import { ProjectPaths } from './paths.js';

async function listDirs(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext))
    .map((e) => join(dir, e.name));
}

/** Read all authored input files for a project (report §9.1). */
export async function loadInputs(paths: ProjectPaths): Promise<LoadedInputs> {
  const characterDocs: FrontMatterDoc[] = [];
  for (const id of await listDirs(paths.charactersDir)) {
    const file = paths.characterFile(id);
    if (await exists(file)) characterDocs.push(parseFrontMatter(await fs.readFile(file, 'utf8')));
  }

  const locationDocs: FrontMatterDoc[] = [];
  for (const file of await listFiles(paths.locationsDir, '.md')) {
    locationDocs.push(parseFrontMatter(await fs.readFile(file, 'utf8')));
  }

  const fountain = await listFiles(paths.screenplayDir, '.fountain');
  const markdown = fountain.length === 0 ? await listFiles(paths.screenplayDir, '.md') : [];
  const scriptPath = fountain[0] ?? markdown[0];
  const scriptText = scriptPath ? await fs.readFile(scriptPath, 'utf8') : '';

  return { characterDocs, locationDocs, scriptText, scriptPath };
}

/** Persist the Mermaid story graph to `work/story.graph.mmd` (report §6). */
export async function writeStoryGraph(paths: ProjectPaths, mermaid: string): Promise<void> {
  await writeFileAtomic(paths.storyGraph, mermaid);
}

/** Write a location breakdown markdown file under `work/locations/<id>/`. */
export async function writeBreakdown(
  paths: ProjectPaths,
  id: string,
  markdown: string,
): Promise<void> {
  await writeFileAtomic(paths.locationBreakdown(id), markdown);
}

/** Write a P3 candidate portrait image into the character's `candidates/` dir. */
export async function writeCandidate(
  paths: ProjectPaths,
  characterId: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  await ensureDir(paths.candidatesDir(characterId));
  const file = join(paths.candidatesDir(characterId), name);
  await writeFileAtomic(file, bytes);
  return file;
}

/** Copy the approved portrait bytes to the visible `approved.png` (report §9.2 gate). */
export async function writeApprovedPortrait(
  paths: ProjectPaths,
  characterId: string,
  bytes: Uint8Array,
): Promise<void> {
  await writeFileAtomic(paths.approvedPortrait(characterId), bytes);
}

/**
 * Flip a character's `character.md` front-matter to approved with the chosen portrait
 * hash (report §P3). Returns false if the character file does not exist.
 */
export async function setCharacterApproval(
  paths: ProjectPaths,
  characterId: string,
  portraitHash: string,
): Promise<boolean> {
  const file = paths.characterFile(characterId);
  if (!(await exists(file))) return false;
  const doc = parseFrontMatter(await fs.readFile(file, 'utf8'));
  doc.data['status'] = 'approved';
  doc.data['approved_portrait'] = portraitHash;
  await writeFileAtomic(file, stringifyFrontMatter(doc.data, doc.body));
  return true;
}
