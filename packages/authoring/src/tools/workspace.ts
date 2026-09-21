/** Workspace-reading tools: files, the input index, full-text search, the archive, the bible. */
import { join } from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { z } from 'zod';
import { formatExcerpts } from '@vn/bible';
import { readDocFile } from '@vn/store';
import { exists, readText } from '@vn/util';
import { listArchive } from '../archive.js';
import { formatIndex } from '../workspace.js';
import { ok, fail, rel, type Tool } from './core.js';

const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name       : 'read_file',
  description:
    'Read a workspace file, optionally a line range. A refusal (binary, too large, outside the ' +
    'workspace) is about the file itself, so retrying with a line range cannot change it — ' +
    'tell the author instead.',
  mutating   : false,
  args: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
  async run(a, ctx) {
    // The same read `doc.read` performs: bounded, text-only, and refused outside the workspace.
    // A file too large to hand a human is also one the agent does not paste into its context.
    const read = await readDocFile(ctx.workspace.root, a.path);
    if (!read.ok) return fail(read.reason);
    const text = read.file.text;
    const whole = a.offset === undefined && a.limit === undefined;
    // Reading records what was shown, so `edit_file` can refuse an edit made against a file this
    // conversation never saw. The output is unchanged.
    ctx.seen?.set(read.file.path, { hash: read.file.hash, whole });
    if (whole) return ok(text, { data: text });
    const lines = text.split('\n');
    const start = Math.max(0, a.offset ?? 0);
    const slice = lines.slice(start, a.limit ? start + a.limit : undefined);
    return ok(slice.join('\n'), { data: slice });
  },
};

const listWorkspaceTool: Tool<Record<string, never>> = {
  name       : 'list_workspace',
  description: 'List the characters, locations, and scenes that exist (a cheap index).',
  mutating   : false,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    const index = await ctx.workspace.index();
    return ok(formatIndex(index), { data: index });
  },
};

const INPUT_GLOBS = ['characters', 'locations', 'scenes', 'screenplay'];

/** What `search` walks, said once so the description and the no-match sentence cannot disagree. */
const SEARCH_SCOPE = `${INPUT_GLOBS.map((g) => `${g}/`).join(', ')}, AICONTEXT.md and project.yaml`;

/** Recursively collect text input files under the workspace's authored directories. */
async function collectInputFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (!(await exists(dir))) return;
    for (const e of await nodeFs.readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(md|fountain|markdown|yaml|yml|txt)$/i.test(e.name)) out.push(p);
    }
  };
  for (const g of INPUT_GLOBS) await walk(join(root, g));
  for (const name of ['AICONTEXT.md', 'project.yaml']) {
    const p = join(root, name);
    if (await exists(p)) out.push(p);
  }
  return out;
}

/** Escape a string for use as a literal regex (search default). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const searchTool: Tool<{ query: string; regex?: boolean }> = {
  name       : 'search',
  description:
    'Search the authored inputs for a string or regex; returns file:line matches. Its scope is ' +
    `${SEARCH_SCOPE} — the story bible (wiki/) and archive/ are searched by search_bible and ` +
    'list_archive instead.',
  mutating   : false,
  args       : z.object({ query: z.string().min(1), regex: z.boolean().optional() }),
  async run(a, ctx) {
    let re: RegExp;
    try {
      re = a.regex ? new RegExp(a.query, 'i') : new RegExp(escapeRegExp(a.query), 'i');
    } catch (err) {
      return fail(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    const files = await collectInputFiles(ctx.workspace.root);
    const matches: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const lines = (await readText(file)).split('\n');
      lines.forEach((text, i) => {
        if (re.test(text))
          matches.push({ file: rel(ctx.workspace.root, file), line: i + 1, text: text.trim() });
      });
    }
    if (matches.length === 0) {
      // A no-match result names what it searched and where else to look; without that, the agent
      // reading it would conclude the fact is nowhere in the project.
      return ok(
        `No matches for "${a.query}" in ${SEARCH_SCOPE}. The story bible (wiki/) and archive/ ` +
          'are not searched — try search_bible or list_archive.',
        { data: [] },
      );
    }
    const body = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n');
    return ok(body, { data: matches });
  },
};

const listArchiveTool: Tool<Record<string, never>> = {
  name       : 'list_archive',
  description:
    'List documents the author uploaded to archive/. They are not in search or the bible — ' +
    'read one with read_file once you know its path.',
  mutating   : false,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    const batches = await listArchive(ctx.workspace);
    if (batches.length === 0) return ok('The archive is empty.', { data: [] });
    const body = batches
      .map((b) => [`${b.dir}/`, ...b.files.map((f) => `  ${f.path} (${f.bytes} bytes)`)].join('\n'))
      .join('\n');
    return ok(body, { data: batches });
  },
};

const searchBibleTool: Tool<{ query: string; limit?: number }> = {
  name       : 'search_bible',
  description:
    'Search the story bible (wiki/) for relevant passages; returns ranked file:line excerpts. ' +
    'The paths it reports are workspace-relative, so a hit can be handed straight to read_file.',
  mutating   : false,
  args: z.object({
    query: z.string().min(1).describe('what you want to know, in words'),
    limit: z.number().optional().describe('most excerpts to return, default 8'),
  }),
  async run(a, ctx) {
    const bible = await ctx.workspace.bible();
    const excerpts = await bible.query(a.query, a.limit === undefined ? {} : { limit: a.limit });
    if (excerpts.length === 0)
      return ok(`Nothing in the bible matches "${a.query}".`, { data: [] });
    // The bible names its files from its own root, a path read_file cannot resolve. Prefixing
    // here rather than in `@vn/bible` leaves the excerpt untouched and turns the citation into
    // a path the agent can paste straight into read_file.
    const wiki = rel(ctx.workspace.root, ctx.workspace.paths.wikiDir);
    const cited = excerpts.map((e) => ({ ...e, file: `${wiki}/${e.file}` }));
    return ok(formatExcerpts(cited), { data: cited });
  },
};

export { readFileTool, listWorkspaceTool, searchTool, listArchiveTool, searchBibleTool };
