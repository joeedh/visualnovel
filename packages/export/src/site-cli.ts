/**
 * The standalone web-export entry: `node vn-site.mjs [--project <dir>] [--out <dir>]`.
 *
 * Reads `vngen/build/story.play.json`, renders it with {@link renderSite}, and copies the assets
 * the pages reference. Not re-exported from the package barrel; this module exists to be bundled
 * by `scripts/esbuild.sitebuilder.mjs`, which explains why it has no dependencies.
 */
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Playable } from '@vn/types';
import { renderSite } from './site.js';

// The three locations this reads. They mirror `ProjectPaths` in `@vn/store` rather than importing
// it, because importing that package for three joins pulls the parser and the model in behind it
// and this file is committed to an author's repository. Two asset roots because base art and shot
// frames live apart; see docs/reference/asset-stores.md.
const STORY_PLAY = ['vngen', 'build', 'story.play.json'];
const BASE_ASSETS = ['assets', 'objects'];
const PROJECT_ASSETS = ['vngen', 'build', 'assets'];

interface Options {
  project: string;
  out: string;
}

/** `--key value` and `--key=value`, both. An unknown flag is an error rather than a no-op. */
function parse(argv: string[]): Options {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    if (key !== 'project' && key !== 'out') throw new Error(`Unknown flag: --${key}`);
    const value = eq === -1 ? argv[++i] : body.slice(eq + 1);
    if (value === undefined) throw new Error(`--${key} needs a value.`);
    flags[key] = value;
  }
  const project = resolve(flags['project'] ?? '.');
  return { project, out: resolve(flags['out'] ?? join(project, 'vngen', 'build', 'site')) };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check that a parsed `story.play.json` has the shape {@link renderSite} reads, and say which
 * field is wrong when it does not.
 *
 * This departs from the repo's rule that machine-read data is validated through the zod schemas
 * in `@vn/types`, and the reason is the bundle. `playableSchema` drags zod in, which takes this
 * file from 275 lines to 4,688 — and this file is committed to an author's git repository, where
 * every reinstall rewrites it as one diff. The input is a file this same toolchain wrote one step
 * earlier, so a structural check that names the bad field is enough.
 */
function asPlayable(value: unknown): Playable {
  const bad = (what: string): never => {
    throw new Error(`not a playable: ${what}`);
  };
  if (!isObject(value)) bad('the file is not a JSON object');
  const raw = value as Record<string, unknown>;
  if (typeof raw['title'] !== 'string') bad('`title` is missing or not a string');
  if (!isObject(raw['characters'])) bad('`characters` is missing or not an object');
  if (!isObject(raw['scenes'])) bad('`scenes` is missing or not an object');
  for (const [id, scene] of Object.entries(raw['scenes'] as Record<string, unknown>)) {
    if (!isObject(scene)) bad(`scene \`${id}\` is not an object`);
    const record = scene as Record<string, unknown>;
    if (!Array.isArray(record['beats'])) bad(`scene \`${id}\` has no \`beats\` array`);
    if (!Array.isArray(record['choices'])) bad(`scene \`${id}\` has no \`choices\` array`);
  }
  return value as unknown as Playable;
}

/**
 * Copy one asset into the site. Bytes live in one of two content-addressed roots, so this tries
 * the base root and then the project root, the order `AssetStore.rootHolding` uses.
 *
 * A ref in neither root is reported and skipped. The exporter already treats a missing asset as
 * an omission rather than an error, and a publish that failed because one picture was never
 * generated would be the wrong answer.
 */
async function copyAsset(
  project: string,
  out: string,
  ref: { hash: string; ext: string },
): Promise<boolean> {
  const file = `${ref.hash}.${ref.ext}`;
  const candidates = [join(project, ...BASE_ASSETS, file), join(project, ...PROJECT_ASSETS, file)];
  for (const from of candidates) {
    try {
      await copyFile(from, join(out, 'assets', file));
      return true;
    } catch {
      // Try the other root. Absent from both is handled after the loop.
    }
  }
  process.stderr.write(`vn-site: no bytes for ${file}; skipping.\n`);
  return false;
}

async function main(argv: string[]): Promise<number> {
  const { project, out } = parse(argv);
  const storyPlay = join(project, ...STORY_PLAY);

  let raw: string;
  try {
    raw = await readFile(storyPlay, 'utf8');
  } catch {
    process.stderr.write(
      `vn-site: no ${storyPlay}. Run \`vngen export\` (or Export in the app) first.\n`,
    );
    return 1;
  }

  let playable: Playable;
  try {
    playable = asPlayable(JSON.parse(raw) as unknown);
  } catch (error) {
    process.stderr.write(`vn-site: ${storyPlay} — ${(error as Error).message}\n`);
    return 1;
  }

  const site = renderSite(playable);
  await mkdir(join(out, 'assets'), { recursive: true });
  for (const page of site.pages) {
    const file = join(out, page.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, page.html, 'utf8');
  }

  let copied = 0;
  for (const ref of site.assets) if (await copyAsset(project, out, ref)) copied++;

  // GitHub Pages runs Jekyll unless told not to, and Jekyll drops every path beginning with an
  // underscore. Nothing here starts with one today; this keeps that from becoming a rule.
  await writeFile(join(out, '.nojekyll'), '', 'utf8');

  // The marker the workflow checks before it force-pushes, so a publish cannot overwrite a
  // gh-pages branch somebody built by hand.
  await writeFile(join(out, '.vn-pages'), 'Published by VN Studio.\n', 'utf8');

  process.stdout.write(
    `vn-site: ${site.pages.length} page(s), ${copied}/${site.assets.length} asset(s) → ${out}\n`,
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
