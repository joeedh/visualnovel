/**
 * Files the app ships, as opposed to files the author wrote.
 *
 * There are two — `docs/guides/api-keys.md`, which the Setup pane renders, and the builtin skill
 * catalog — and both have the awkward property of living under the repo root in a checkout and
 * inside the installer's resources directory in a packaged build. Resolving that in one place
 * means a caller asks for a resource by name and never learns which kind of build it is running
 * in.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILTIN_SKILLS_PATH } from '@vn/authoring';

/**
 * Candidate paths for a shipped file, in the order a build is likeliest to match.
 *
 * `process.resourcesPath` is Electron's and is undefined under plain node, so a jest run falls
 * through to the checkout, and so does `pnpm dev`.
 */
function candidates(parts: string[]): string[] {
  const roots: string[] = [];
  const override = process.env.VN_RESOURCES?.trim();
  if (override) roots.push(override);
  const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (packaged) roots.push(packaged);
  // `__dirname` is `apps/desktop/dist/main` at runtime, so four up is the repo root.
  roots.push(join(__dirname, '..', '..', '..', '..'));
  return roots.map((root) => join(root, ...parts));
}

/** The first candidate that exists, or `undefined` when none of them do. */
export function resourcePath(...parts: string[]): string | undefined {
  return candidates(parts).find((path) => existsSync(path));
}

/**
 * The builtin skill catalog, at its checkout path in every kind of build: `extraResources` in
 * `electron-builder.yml` and `scripts/package.desktop.mjs` both copy it under that same path, so
 * one spelling serves the checkout and the installer. Undefined in a build that lost it, which
 * the skill roots read as "no builtin tier" rather than as an error.
 */
export function builtinSkillsDir(): string | undefined {
  return resourcePath(...BUILTIN_SKILLS_PATH);
}

/**
 * Read a shipped file, failing by name. A packaging mistake that drops a resource is invisible
 * until someone opens the pane that needs it, so the error says which file and where it looked
 * rather than surfacing as a bare ENOENT on a path nobody chose.
 */
export async function readResource(...parts: string[]): Promise<string> {
  const path = resourcePath(...parts);
  if (!path) {
    throw new Error(
      `This build is missing ${parts.join('/')}. Looked in: ${candidates(parts).join(', ')}.`,
    );
  }
  return readFile(path, 'utf8');
}
