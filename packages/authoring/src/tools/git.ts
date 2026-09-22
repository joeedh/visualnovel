// ── Git ─────────────────────────────────────────────────────────────────────
import { z } from 'zod';
import {
  InProgressError,
  makersOf,
  operationOf,
  previewCheckpoint,
  previewTakeBack,
  statusCause,
  type Git,
  type Maker,
  type MakerContext,
} from '@vn/git';
import { resolutionProblem, sceneTextProblem } from '@vn/model';
import { inSecretsDir, readDocFile, SECRETS_REFUSAL, writeDocFile } from '@vn/store';
import { hasConflictMarkers, writeFileAtomic } from '@vn/util';
import { join } from 'node:path';
import { AGENT_WRITERS, ok, fail, type Tool, type ToolContext } from './core.js';

/**
 * What a sync tool says while the author's sync is stopped part way: the History pane finishes
 * it, and the agent has no tool for that.
 */
export const SYNC_PART_WAY =
  'A sync is part way; the author finishes it from the History pane, so there is nothing to ' +
  'commit here.';

const SCENE_PATH = /^scenes\/[^/]+\.md$/;

/**
 * Why `path` may not be written by an ordinary write, or undefined when it may: a file a stopped
 * sync is waiting on is decided whole, through `resolve_conflict`, so that the decision is staged.
 * A plain write leaves git still waiting, and the author's Continue refuses a file nobody decided.
 *
 * Cheap in the ordinary case: the status is only read while a sync is actually in progress.
 */
export async function conflictRefusal(ctx: ToolContext, path: string): Promise<string | undefined> {
  const busy = operationOf(await ctx.git.inProgress());
  if (!busy) return undefined;
  const status = await ctx.git.branchStatus();
  if (!status.entries.some((e) => e.unmerged && e.path === path)) return undefined;
  return (
    `${path} is waiting on a merge decision — resolve_conflict decides it, with the whole file ` +
    'as it should read. An ordinary write would leave the sync still waiting on it.'
  );
}

const short = (sha: string): string => sha.slice(0, 7);

/** The identity commits are made with here, so a collaborator's save can be told from the author's. */
async function makerContext(git: Git): Promise<MakerContext> {
  return {
    local: { name: await git.configGet('user.name'), email: await git.configGet('user.email') },
  };
}

const MAKER_SAYS: Record<Maker, string> = {
  author      : 'author',
  agent       : 'agent',
  pipeline    : 'pipeline',
  housekeeping: 'housekeeping',
  other       : 'someone else',
  unknown     : 'outside the app',
};

const gitStatusTool: Tool<Record<string, never>> = {
  name       : 'git_status',
  description:
    'Where the project stands: whether everything is saved and if not why, the branch, and how ' +
    'many saves are unsent or unfetched against its shared copy.',
  mutating   : false,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    if (!(await ctx.git.isRepo())) return ok('Not a git repository.');
    const [branch, inProgress] = await Promise.all([ctx.git.branchStatus(), ctx.git.inProgress()]);
    const status = statusCause(branch.entries, 0, inProgress);
    const data = {
      ...status,
      branch  : branch.head ?? inProgress.rebase?.branch ?? null,
      upstream: branch.upstream,
      ahead   : branch.ahead,
      behind  : branch.behind,
    };
    const lines = [`On ${data.branch ?? 'no branch'}`];
    if (branch.upstream)
      lines.push(
        `Shared copy ${branch.upstream}: ${branch.ahead ?? '?'} to send, ${branch.behind ?? '?'} to get.`,
      );
    const busy = operationOf(inProgress);
    if (busy) lines.push(`A ${busy} is in progress.`);
    if (status.cause === 'outside') {
      lines.push('Changed on disk and not yet saved:', ...status.outside.map((p) => `  ${p}`));
    } else if (status.cause === 'clean') lines.push('Everything is saved.');
    if (status.conflicted.length > 0) {
      lines.push('Conflicted:', ...status.conflicted.map((p) => `  ${p}`));
    }
    return ok(lines.join('\n'), { data });
  },
};

const gitLogTool: Tool<{ limit?: number; path?: string; who?: string }> = {
  name       : 'git_log',
  description:
    'The project’s saves, newest first: who made each (author, agent, pipeline, housekeeping), ' +
    'when, what it says, how many files it touched, and any checkpoint naming it. `path` narrows ' +
    'to the saves that touched one file; `who` to one maker.',
  mutating   : false,
  args: z.object({
    limit: z.number().optional(),
    path : z.string().optional().describe('workspace-relative path'),
    who  : z.enum(['author', 'agent', 'pipeline', 'housekeeping', 'other', 'unknown']).optional(),
  }),
  async run(a, ctx) {
    if (!(await ctx.git.isRepo())) return ok('Not a git repository.');
    const limit = a.limit ?? 20;
    const [entries, checkpoints, mc] = await Promise.all([
      ctx.git.history({ limit, ...(a.path ? { path: a.path } : {}) }),
      ctx.git.checkpoints(),
      makerContext(ctx.git),
    ]);
    const makers = makersOf(entries, mc);
    const rows = entries
      .map((e, i) => ({
        sha        : e.sha,
        date       : e.date,
        author     : e.author,
        subject    : e.subject,
        maker      : makers[i]!,
        files      : e.files.length,
        checkpoints: checkpoints.filter((c) => c.sha === e.sha).map((c) => c.name),
      }))
      .filter((row) => !a.who || row.maker === a.who);
    const body = rows
      .map((r) => {
        const marks = r.checkpoints.length ? ` ⚑ ${r.checkpoints.join(', ')}` : '';
        return `${short(r.sha)} ${r.date.slice(0, 16)} [${MAKER_SAYS[r.maker]}] ${r.subject} (${r.files} file${r.files === 1 ? '' : 's'})${marks}`;
      })
      .join('\n');
    return ok(body || '(no saves)', { data: rows });
  },
};

const gitShowTool: Tool<{ ref: string }> = {
  name       : 'git_show',
  description:
    'One save in full: its message, who made it, what the app ran, and every file it touched ' +
    'with the line counts.',
  mutating   : false,
  args       : z.object({ ref: z.string().min(1) }),
  async run(a, ctx) {
    const [entry] = await ctx.git.history({ from: a.ref, limit: 1 });
    if (!entry) return fail(`No save ${a.ref} in this repository.`);
    const [changes, mc] = await Promise.all([ctx.git.changes(entry.sha), makerContext(ctx.git)]);
    const [maker] = makersOf([entry], mc);
    const data = { ...entry, maker, changes };
    const lines = [
      `${short(entry.sha)} ${entry.subject}`,
      `${entry.author} · ${entry.date} · ${MAKER_SAYS[maker!]}`,
    ];
    for (const [key, value] of Object.entries(entry.trailers)) lines.push(`${key}: ${value}`);
    if (entry.body) lines.push('', entry.body);
    lines.push('');
    for (const c of changes) {
      const counts = c.added === null ? 'binary' : `+${c.added} −${c.removed}`;
      const renamed = c.oldPath ? ` (was ${c.oldPath})` : '';
      lines.push(`${c.status} ${c.path}${renamed} ${counts}`);
    }
    return ok(lines.join('\n'), { data });
  },
};

const gitDiffTool: Tool<{ ref?: string; path?: string }> = {
  name       : 'git_diff',
  description:
    'With `ref`, how that save changed its files — every file with its counts, and the full ' +
    'text of the change for `path` when one is named. Without `ref`, what is changed on disk ' +
    'and not yet saved.',
  mutating   : false,
  args: z.object({
    ref : z.string().optional(),
    path: z.string().optional().describe('workspace-relative path'),
  }),
  async run(a, ctx) {
    if (a.ref) {
      const changes = await ctx.git.changes(a.ref);
      const listed = changes
        .map(
          (c) =>
            `${c.status} ${c.path} ${c.added === null ? 'binary' : `+${c.added} −${c.removed}`}`,
        )
        .join('\n');
      if (!a.path) return ok(listed || '(no changes)', { data: { changes } });
      const diff = await ctx.git.diffPath(a.ref, a.path);
      return ok(diff.binary ? `${a.path}: binary` : diff.text || '(no changes)', {
        data: { changes, path: a.path, ...diff },
      });
    }
    const status = await ctx.git.status();
    const text = await ctx.git.diff(a.path ? { paths: [a.path] } : {});
    const entries = status.entries.filter((e) => !a.path || e.path === a.path);
    const listed = entries.map((e) => `${e.x}${e.y} ${e.path}`).join('\n');
    return ok([listed, text].filter((s) => s !== '').join('\n\n') || '(no changes)', {
      data: { entries, text },
    });
  },
};

const gitCommitTool: Tool<{ message: string; paths?: string[] }> = {
  name       : 'git_commit',
  description:
    'Stage and commit the approved change set with a message. Send the message alone: what you ' +
    'wrote this plan is already tracked, and a remembered list of paths can only be shorter.',
  mutating   : true,
  args: z.object({
    message: z.string().min(1),
    paths: z
      .array(z.string())
      .optional()
      .describe('rarely needed: extra paths to commit beyond the ones you wrote'),
  }),
  async run(a, ctx) {
    if (!(await ctx.git.isRepo())) return fail('Not a git repository (offer git_init).');
    // The source is this tool's to state; the conversation and the plan are the host's and the
    // loop's, read now so the commit names the thread it was made in
    const trailers = { 'Vn-Source': 'agent', ...(ctx.trailers?.() ?? {}) };
    let hash: string | null;
    try {
      hash = await ctx.git.commit({ message: a.message, paths: a.paths, trailers });
    } catch (err) {
      if (err instanceof InProgressError) return fail(SYNC_PART_WAY);
      throw err;
    }
    return hash
      ? ok(`Committed ${hash.slice(0, 8)}: ${a.message}`, { data: hash })
      : ok('Nothing to commit.');
  },
};

const resolveConflictTool: Tool<{ path: string; text: string }> = {
  name       : 'resolve_conflict',
  description:
    'Write the merged text of one file a stopped sync is waiting on, and mark it decided. The ' +
    'file as read_file shows it holds both versions between git’s markers: the lines from ' +
    '<<<<<<< to ======= are the collaborator’s (git labels them HEAD or ours), the lines from ' +
    '======= to >>>>>>> are the author’s (labelled with their save, or theirs). Send the whole ' +
    'file as it should read, with every marker line removed and what each of them meant kept. ' +
    'Refused until the file has been read this conversation, and when the result would not ' +
    'load. The author can undo it from the History pane; nothing here commits.',
  mutating   : true,
  args: z.object({
    path: z.string().min(1).describe('workspace-relative path'),
    text: z.string().describe('the whole file, merged, with no marker lines left'),
  }),
  async run(a, ctx) {
    const path = a.path.replace(/\\/g, '/');
    if (!(await ctx.git.inProgress()).rebase) {
      return fail('No sync is waiting on a decision.');
    }
    const status = await ctx.git.branchStatus();
    if (!status.entries.some((e) => e.unmerged && e.path === path)) {
      return fail(`${path} is not waiting on a decision.`);
    }
    const read = await readDocFile(ctx.workspace.root, path);
    if (!read.ok) return fail(read.reason);
    if (!hasConflictMarkers(read.file.text)) {
      return fail(
        `${path} was not merged line by line, so there is no middle to write; the author keeps ` +
          'one side or the other from the History pane.',
      );
    }
    const seen = ctx.seen?.get(read.file.path);
    if (!seen) {
      return fail(
        `${path} has not been read this conversation — read_file it first, so the merge is ` +
          'made from what is actually there.',
      );
    }
    if (read.file.hash !== seen.hash) {
      return fail(
        `${path} changed since you read it (read at ${seen.hash.slice(0, 12)}, now ` +
          `${read.file.hash.slice(0, 12)}) — read_file it again and merge that.`,
      );
    }
    const problem = resolutionProblem(path, a.text);
    if (problem !== undefined) return fail(problem);

    // The same split as git.writeResolution: a scene and anything that is not markdown verbatim,
    // a markdown document through the guarded writer
    if (SCENE_PATH.test(path) || !path.endsWith('.md')) {
      await writeFileAtomic(join(ctx.workspace.root, path), a.text);
    } else {
      const written = await writeDocFile(
        ctx.workspace.root,
        path,
        a.text,
        seen.hash,
        AGENT_WRITERS,
      );
      if (!written.ok) return fail(written.reason);
    }
    await ctx.git.add([path]);
    const after = await readDocFile(ctx.workspace.root, path);
    if (after.ok) ctx.seen?.set(after.file.path, { hash: after.file.hash, whole: true });
    return ok(`Decided ${path}; the merged file is staged for the save being replayed.`, {
      written: [read.file.path],
    });
  },
};

const gitRevertTool: Tool<{ ref: string }> = {
  name       : 'git_revert',
  description:
    'Take one save back: reverse what it changed, as a new save. Refused when a later save ' +
    'changed the same lines, when the save is a merge or the first, and while anything is ' +
    'changed on disk. Always confirmed.',
  mutating   : true,
  confirm    : true,
  args       : z.object({ ref: z.string().min(1) }),
  async run(a, ctx) {
    const preview = await previewTakeBack(ctx.git, a.ref);
    if (!preview.ok) return fail(preview.reason);
    if (!(await ctx.git.revertIntoTree(preview.entry.sha))) {
      return fail('Taking the save back conflicted after all; nothing was changed.');
    }
    const written = preview.entry.files.map((f) => f.path);
    const trailers = { 'Vn-Source': 'agent', ...(ctx.trailers?.() ?? {}) };
    const hash = await ctx.git.commit({
      message: `Took back: ${preview.entry.subject}`,
      paths  : ['-A'],
      trailers,
    });
    return ok(
      `Took back ${short(preview.entry.sha)} (${preview.entry.subject}) as ${hash ? short(hash) : 'no change'}.`,
      {
        written,
        data: hash,
      },
    );
  },
};

const gitRestoreTool: Tool<{ path: string; ref?: string }> = {
  name       : 'git_restore',
  description:
    'Bring one file back as it was at an earlier save (HEAD when no ref is given). A scene is ' +
    'checked to load before it is written; keys/ is never touched. Always confirmed.',
  mutating   : true,
  confirm    : true,
  args       : z.object({ path: z.string().min(1), ref: z.string().optional() }),
  async run(a, ctx) {
    const ref = a.ref ?? 'HEAD';
    // A restore mid-rebase would overwrite a file the sync is waiting on, or land in the
    // replayed save unasked; the History pane's own restore refuses the same way
    if (operationOf(await ctx.git.inProgress())) return fail(SYNC_PART_WAY);
    const refusal = await restoreRefusal(ctx, a.path, ref);
    if (refusal) return fail(refusal);
    await ctx.git.restore(a.path, ref);
    return ok(`Restored ${a.path} to ${ref}.`, { written: [a.path] });
  },
};

/** Why `path` at `ref` may not be written over the working copy, or undefined when it may. */
export async function restoreRefusal(
  ctx: ToolContext,
  path: string,
  ref: string,
): Promise<string | undefined> {
  if (inSecretsDir(path)) return SECRETS_REFUSAL;
  const bytes = await ctx.git.blob(ref, path);
  if (bytes === null) return `That save has no ${path}.`;
  const scene = /^scenes\/([^/]+)\.md$/.exec(path.replace(/\\/g, '/'));
  if (!scene) return undefined;
  const problem = sceneTextProblem(scene[1]!, bytes.toString('utf8'));
  return problem === undefined ? undefined : `${path} as it was then would not load: ${problem}`;
}

const gitCheckpointTool: Tool<{ name: string; note?: string; ref?: string }> = {
  name       : 'git_checkpoint',
  description:
    'Name a save as a checkpoint, so the author can find it and go back to it later. Names the ' +
    'latest save unless `ref` picks another. Refused when the name is taken.',
  mutating   : true,
  args: z.object({
    name: z.string().min(1),
    note: z.string().optional().describe('why this point is worth keeping'),
    ref : z.string().optional(),
  }),
  async run(a, ctx) {
    const sha = a.ref ?? (await ctx.git.head());
    if (!sha) return fail('There is no save to name yet.');
    const preview = await previewCheckpoint(ctx.git, a.name, sha);
    if (!preview.ok) return fail(preview.reason);
    const note = a.note?.trim();
    await ctx.git.tag(
      preview.slug,
      preview.entry.sha,
      note ? `${a.name.trim()}\n\n${note}` : a.name.trim(),
    );
    return ok(
      `Checkpoint “${a.name.trim()}” on ${short(preview.entry.sha)}: ${preview.entry.subject}`,
      {
        data: { slug: preview.slug, sha: preview.entry.sha },
      },
    );
  },
};

const gitInitTool: Tool<Record<string, never>> = {
  name       : 'git_init',
  description: 'Initialize a git repository in the workspace.',
  mutating   : true,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    if (await ctx.git.isRepo()) return ok('Already a git repository.');
    await ctx.git.init();
    return ok('Initialized empty git repository.');
  },
};

export {
  gitStatusTool,
  gitLogTool,
  gitShowTool,
  gitDiffTool,
  gitCommitTool,
  gitRevertTool,
  gitRestoreTool,
  gitCheckpointTool,
  gitInitTool,
  resolveConflictTool,
};
