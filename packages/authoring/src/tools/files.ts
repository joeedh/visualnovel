/** The agent's general-purpose file writers, gated away from the tools that own specific paths. */
import { z } from 'zod';
import { pluginWriteRefusal } from '@vn/gengraph/state';
import {
  guardedDir,
  readDocFile,
  resolveInWorkspace,
  workspacePath,
  writeDocFile,
} from '@vn/store';
import { readText, unifiedDiff } from '@vn/util';
import { updateContext } from '../context.js';
import { skillWriteRefusal } from '../skills.js';
import { wrapWarning, WRAP_COLUMNS } from '../wrap.js';
import { AGENT_WRITERS, ok, fail, rel, type Tool } from './core.js';
import { conflictRefusal } from './git.js';

/**
 * The validated writer a path belongs to, or null when no tool owns it. `guardedDir` covers the
 * directories every surface refuses; the two entity directories are this agent's own rule, because
 * a sheet hand-written as raw YAML bypasses the schema entirely.
 */
function ownedElsewhere(path: string): string | null {
  const guarded = guardedDir(path);
  if (guarded) return AGENT_WRITERS[guarded];
  const top = path.split('/')[0];
  if (top === 'characters') return 'create_character / edit_character';
  if (top === 'locations') return 'create_location / edit_location';
  return null;
}

const writeFileTool: Tool<{ path: string; content: string }> = {
  name       : 'write_file',
  description:
    'Create or overwrite a workspace file, whole. Execute mode only. To change part of a file ' +
    'that already exists, use edit_file — an overwrite of a file this conversation has not read ' +
    'is refused. Never for scenes/ (edit_scene), characters/ or locations/ (their own tools). ' +
    `Wrap what you write at ${WRAP_COLUMNS} columns; the receipt says so when a line runs past it.`,
  mutating   : true,
  args       : z.object({ path: z.string(), content: z.string() }),
  async run(a, ctx) {
    // Before the workspace check, because the plugins root is outside every workspace and
    // `resolveInWorkspace` would otherwise refuse the path as out of bounds without saying why.
    const pluginRefusal = pluginWriteRefusal(a.path);
    if (pluginRefusal) return fail(pluginRefusal);

    const abs = resolveInWorkspace(ctx.workspace.root, a.path);
    if (!abs) return fail(`path "${a.path}" is outside the workspace`);
    const path = workspacePath(ctx.workspace.root, abs);
    const owner = ownedElsewhere(path);
    if (owner) return fail(`${path} is written by ${owner}, not write_file`);

    // Prose only. `git_restore` and `git_revert` still take an arbitrary path and are
    // deliberately left ungated here: both are `confirm: true` and their cards name the file,
    // so a person approves that specific restore. This gate is about authoring a script.
    const refusal = skillWriteRefusal(path);
    if (refusal) return fail(refusal);

    const undecided = await conflictRefusal(ctx, path);
    if (undecided) return fail(undecided);

    // A missing ledger entry asserts that no file exists at the path: a creation then succeeds,
    // and an unread overwrite is refused with `already exists` instead of quietly replacing a
    // file the conversation never read.
    const seen = ctx.seen?.get(path);
    // What the file said before, for the diff the transcript shows; a new file diffs from nothing
    const before = seen ? await readDocFile(ctx.workspace.root, path) : undefined;
    const written = await writeDocFile(
      ctx.workspace.root,
      path,
      a.content,
      seen?.hash ?? '',
      AGENT_WRITERS,
    );
    if (!written.ok) return fail(written.reason);
    ctx.seen?.set(path, { hash: written.hash, whole: true });
    // Warned after the write rather than refused before it: the file is already correct prose,
    // and rejecting the write would cost a whole second generation just to fix a line break.
    const long = wrapWarning(a.content);
    return ok(`Wrote ${path} (${written.bytes.toLocaleString()} bytes).${long}`, {
      written: [path],
      // For the transcript, not the model: the model wrote the content and needs no copy of it
      data   : { diff: unifiedDiff(before?.ok ? before.file.text : '', a.content) },
    });
  },
};

const CONTEXT_LINES = 3;

/** A quoted fragment, short enough to read in a refusal. */
function clip(text: string, max = 60): string {
  const oneLine = text.replace(/\n/g, '\\n');
  return oneLine.length <= max ? `"${oneLine}"` : `"${oneLine.slice(0, max)}…"`;
}

/** How many times `needle` occurs in `hay`, non-overlapping. */
function occurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * One change as the model reads it back: three lines of context each side, the old lines marked
 * `-` and the new ones `+`. Whole lines, not the matched fragment — a bare `- in spring` says
 * nothing about where it sat. Rendered against the text as it stood when that edit landed, which
 * is the only version whose line numbers mean anything. Returning the whole file instead would
 * hand back everything the tool exists to save, and a model shown a whole file tends to rewrite it.
 */
function renderHunk(
  text: string,
  index: number,
  edit: { old: string; new: string },
  ordinal: number,
  count: number,
): string {
  const lines = text.split('\n');
  const at = text.slice(0, index).split('\n').length - 1;
  // Widen the match out to line boundaries either side, so both halves read as lines of the file.
  const from = text.lastIndexOf('\n', index - 1) + 1;
  const after = index + edit.old.length;
  const breakAt = text.indexOf('\n', after);
  const to = breakAt === -1 ? text.length : breakAt;
  const removed = text.slice(from, to).split('\n');
  const added = (text.slice(from, index) + edit.new + text.slice(after, to)).split('\n');

  const head = lines.slice(Math.max(0, at - CONTEXT_LINES), at).map((l) => `  ${l}`);
  const past = at + removed.length;
  const tail = lines.slice(past, Math.min(lines.length, past + CONTEXT_LINES)).map((l) => `  ${l}`);
  const more = count > 1 ? ` (and ${count - 1} more like it)` : '';
  return [
    `@@ edit ${ordinal}, line ${at + 1}${more}`,
    ...head,
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
    ...tail,
  ]
    .join('\n')
    .trimEnd();
}

const editFileTool: Tool<{
  path: string;
  edits: { old: string; new: string; all?: boolean }[];
}> = {
  name       : 'edit_file',
  description:
    'Replace exact strings in a workspace file, leaving the rest untouched — the way to change ' +
    'part of a long document without restating it. Each `old` must appear exactly once unless ' +
    '`all` is set. Read the file first: an edit to a file you have not read, or that changed ' +
    'since you read it, is refused. Not for scenes/ (edit_scene), characters/ or locations/ ' +
    '(their own tools).',
  mutating   : true,
  args: z.object({
    path : z.string(),
    edits: z
      .array(z.object({ old: z.string(), new: z.string(), all: z.boolean().optional() }))
      .min(1),
  }),
  async run(a, ctx) {
    // The same gate `write_file` has, and ahead of the workspace check for the same reason.
    const pluginRefusal = pluginWriteRefusal(a.path);
    if (pluginRefusal) return fail(pluginRefusal);

    const abs = resolveInWorkspace(ctx.workspace.root, a.path);
    if (!abs) return fail(`path "${a.path}" is outside the workspace`);
    const path = workspacePath(ctx.workspace.root, abs);
    const owner = ownedElsewhere(path);
    if (owner) return fail(`${path} is written by ${owner}, not edit_file`);

    // The same gate `write_file` has, for the same reason: a skill is prose the agent writes
    // through `create_skill`/`edit_skill`, and an edit is another way to author a `run.mjs`,
    // one that changes a script a person already vetted.
    const skillRefusal = skillWriteRefusal(path);
    if (skillRefusal) return fail(skillRefusal);

    const undecided = await conflictRefusal(ctx, path);
    if (undecided) return fail(undecided);

    const seen = ctx.seen?.get(path);
    if (!seen) {
      return fail(
        `${path} has not been read this conversation — read_file it first, so an edit is made ` +
          'against what is actually there.',
      );
    }
    const read = await readDocFile(ctx.workspace.root, path);
    if (!read.ok) return fail(read.reason);
    if (read.file.hash !== seen.hash) {
      return fail(
        `${path} changed since you read it (read at ${seen.hash.slice(0, 12)}, now ` +
          `${read.file.hash.slice(0, 12)}) — read_file it again and reapply.`,
      );
    }

    // Every edit lands in memory first and the result is written once, so a refusal half-way
    // through leaves the file exactly as the model last read it and the call is safe to retry.
    const original = read.file.text;
    let text = original;
    const hunks: string[] = [];
    for (const [i, edit] of a.edits.entries()) {
      const found = occurrences(text, edit.old);
      if (found === 0) {
        return fail(
          `edit ${i + 1}: ${clip(edit.old)} does not appear in ${path} — matching is exact, ` +
            'including whitespace and indentation. Nothing was written.',
        );
      }
      if (found > 1 && !edit.all) {
        return fail(
          `edit ${i + 1}: ${clip(edit.old)} appears ${found} times in ${path} — extend it until ` +
            'it is unique, or pass all: true. Nothing was written.',
        );
      }
      const index = text.indexOf(edit.old);
      hunks.push(renderHunk(text, index, edit, i + 1, edit.all ? found : 1));
      text = edit.all
        ? text.split(edit.old).join(edit.new)
        : text.slice(0, index) + edit.new + text.slice(index + edit.old.length);
    }

    if (text === original) return ok(`${path} already reads exactly this way — nothing written.`);

    // The same writer the Wiki pane saves through, so front-matter that will not parse and a
    // dropped `type:` tag earn the same refusal here as they do there.
    const written = await writeDocFile(ctx.workspace.root, path, text, seen.hash, AGENT_WRITERS);
    if (!written.ok) return fail(written.reason);
    ctx.seen?.set(path, { hash: written.hash, whole: seen.whole });

    const summary =
      `Edited ${path} — ${a.edits.length} change(s), ` +
      `${Buffer.byteLength(original, 'utf8').toLocaleString()} → ` +
      `${written.bytes.toLocaleString()} bytes.`;
    return ok(`${summary}\n\n${hunks.join('\n\n')}`, {
      written: [path],
      data   : { diff: unifiedDiff(original, text) },
    });
  },
};

const regenerateContextTool: Tool<Record<string, never>> = {
  name       : 'regenerate_context',
  description:
    'Rebuild AICONTEXT.generated.md — the project map: the cast, the locations, the story graph, ' +
    "and the story bible's table of contents. Facts only; it never copies what a file says.",
  mutating   : true,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    const { file, counts } = await ctx.workspace.writeGeneratedContext();
    const summary =
      `${counts.characters} character(s), ${counts.locations} location(s), ` +
      `${counts.scenes} scene(s), ${counts.bible} bible note(s)`;
    return ok(`Regenerated the project map from ${summary}.`, {
      written: [rel(ctx.workspace.root, file)],
      data   : counts,
    });
  },
};

const updateContextTool: Tool<{ rule: string }> = {
  name       : 'update_context',
  description:
    'Persist a durable instruction into AICONTEXT.md. Returns the file as it now stands, so ' +
    'what you wrote is visible without reading it back.',
  mutating   : true,
  args       : z.object({ rule: z.string().min(1) }),
  async run(a, ctx) {
    const file = await updateContext(ctx.workspace.root, a.rule);
    // Return the whole file rather than a receipt: the rule lands in a file the agent did not
    // write in full, and a bare receipt would make the next call a read_file of what it just did.
    const text = await readText(file);
    return ok(`Recorded rule in AICONTEXT.md, which now reads:\n\n${text}`, {
      written: [rel(ctx.workspace.root, file)],
      data   : text,
    });
  },
};

export { writeFileTool, editFileTool, regenerateContextTool, updateContextTool };
