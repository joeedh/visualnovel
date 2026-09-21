/**
 * The tools that let the agent read the UX docs tree (`docs/plans/agent-reads-the-ux-model.md`):
 * `ux_list`, `ux_read` and `ux_search` over the pages `scripts/gen-ux-docs.mjs` wrote under
 * `uxDocsDir()`.
 *
 * They are separate from `read_file` and `search` because the tree is not in the workspace:
 * `read_file` feeds `edit_file`'s ledger and every write tool refuses a path outside the
 * workspace, so a virtual root under them would need an exception in each. Three small read-only
 * tools cost less, and the deferred catalog makes their schemas free until searched for.
 *
 * All three are `mutating: false`, so plan mode allows them. They take the tree's root, and the
 * host registers them only where the root exists.
 */
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolResult } from '@vn/authoring';
import { resolveInWorkspace } from '@vn/store';

/** Hits one search returns before it says how many more there were. */
export const UX_SEARCH_CAP = 200;

const ok = (output: string, extra: Partial<ToolResult> = {}): ToolResult => ({
  ok: true,
  output,
  ...extra,
});
const fail = (output: string): ToolResult => ({ ok: false, output });

const posix = (path: string): string => path.split('\\').join('/');

const escaped = (path: string): string => `path "${path}" is outside the UX docs tree`;

/** Every page under `root`, tree-relative and forward-slashed, in path order. */
async function walk(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, full)));
    else if (entry.name.endsWith('.md')) out.push(posix(relative(root, full)));
  }
  return out.sort();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listTool(root: string): Tool<{ dir?: string }> {
  return {
    name       : 'ux_list',
    description:
      'List the UX docs tree, which says which pane draws each command, when it is refused and ' +
      'what the refusal says: commands/<namespace>/, effects/, editors/, situations/, ' +
      'interactions/, shortcuts.md, and README.md, which explains the pages. Optionally one ' +
      'directory of it.',
    mutating   : false,
    args       : z.object({ dir: z.string().optional() }),
    async run(a) {
      const dir = a.dir === undefined || a.dir === '' ? root : resolveInWorkspace(root, a.dir);
      if (dir === null) return fail(escaped(a.dir ?? ''));
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return fail(`no such directory in the UX docs tree: ${a.dir}`);
      }
      const names = entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
      return ok(names.join('\n'), { data: names });
    },
  };
}

function readTool(root: string): Tool<{ path: string; offset?: number; limit?: number }> {
  return {
    name       : 'ux_read',
    description:
      'Read one page of the UX docs tree, optionally a line range. Before writing a show_me ' +
      'step, read commands/<namespace>/<name>.md: it says which pane draws the control, which ' +
      'props the control already knows, and the sentence to use when the command is refused.',
    mutating   : false,
    args: z.object({
      path  : z.string(),
      offset: z.number().optional(),
      limit : z.number().optional(),
    }),
    async run(a) {
      const abs = resolveInWorkspace(root, a.path);
      if (abs === null) return fail(escaped(a.path));
      let text: string;
      try {
        text = await fs.readFile(abs, 'utf8');
      } catch {
        return fail(`no such page in the UX docs tree: ${a.path} (ux_list shows what there is)`);
      }
      if (a.offset === undefined && a.limit === undefined) return ok(text, { data: text });
      const lines = text.split('\n');
      const start = Math.max(0, a.offset ?? 0);
      const slice = lines.slice(start, a.limit ? start + a.limit : undefined);
      return ok(slice.join('\n'), { data: slice });
    },
  };
}

function searchTool(root: string): Tool<{ query: string; regex?: boolean }> {
  return {
    name       : 'ux_search',
    description:
      'Search every page of the UX docs tree for a string or regex; returns path:line hits. A ' +
      'hit on a command page is one table row, so a tooltip, a refusal sentence, a label or an ' +
      `editor name finds the commands it belongs to. At most ${UX_SEARCH_CAP} hits are returned; ` +
      'narrow the query when it says there were more.',
    mutating   : false,
    args       : z.object({ query: z.string().min(1), regex: z.boolean().optional() }),
    async run(a) {
      let re: RegExp;
      try {
        re = new RegExp(a.regex ? a.query : escapeRegExp(a.query), 'i');
      } catch (err) {
        return fail(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const hits: { path: string; line: number; text: string }[] = [];
      let more = 0;
      for (const path of await walk(root)) {
        const lines = (await fs.readFile(join(root, path), 'utf8')).split('\n');
        lines.forEach((text, i) => {
          if (!re.test(text)) return;
          if (hits.length < UX_SEARCH_CAP) hits.push({ path, line: i + 1, text: text.trim() });
          else more += 1;
        });
      }
      if (hits.length === 0) {
        return ok(`No matches for "${a.query}" in the UX docs tree.`, { data: [] });
      }
      const body = hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
      if (more > 0) body.push(`… and ${more} more. Narrow the query.`);
      return ok(body.join('\n'), { data: hits });
    },
  };
}

/** The three readers over a tree at `root`. */
export function uxDocsTools(root: string): Tool[] {
  return [listTool(root), readTool(root), searchTool(root)] as Tool[];
}
