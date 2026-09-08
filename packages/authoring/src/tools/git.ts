// ── Git ─────────────────────────────────────────────────────────────────────
import { z } from 'zod';
import { ok, fail, type Tool } from './core.js';

const gitStatusTool: Tool<Record<string, never>> = {
  name       : 'git_status',
  description: 'Show the working-tree status.',
  mutating   : false,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    if (!(await ctx.git.isRepo())) return ok('Not a git repository.');
    const s = await ctx.git.status();
    const body = s.dirty ? s.entries.map((e) => `${e.x}${e.y} ${e.path}`).join('\n') : 'clean';
    return ok(`On ${s.branch}\n${body}`, { data: s });
  },
};

const gitLogTool: Tool<{ limit?: number }> = {
  name       : 'git_log',
  description: 'Show recent commit history.',
  mutating   : false,
  args       : z.object({ limit: z.number().optional() }),
  async run(a, ctx) {
    if (!(await ctx.git.isRepo())) return ok('Not a git repository.');
    const log = await ctx.git.log(a.limit ?? 20);
    const body = log.map((c) => `${c.shortHash} ${c.date} ${c.subject}`).join('\n');
    return ok(body || '(no commits)', { data: log });
  },
};

const gitShowTool: Tool<{ ref: string }> = {
  name       : 'git_show',
  description: 'Show a commit (metadata + patch).',
  mutating   : false,
  args       : z.object({ ref: z.string().min(1) }),
  async run(a, ctx) {
    return ok(await ctx.git.show(a.ref));
  },
};

const gitDiffTool: Tool<{ ref?: string; staged?: boolean }> = {
  name       : 'git_diff',
  description: 'Show a unified diff of the working tree (or against a ref).',
  mutating   : false,
  args       : z.object({ ref: z.string().optional(), staged: z.boolean().optional() }),
  async run(a, ctx) {
    const diff = await ctx.git.diff({ ref: a.ref, staged: a.staged });
    return ok(diff || '(no changes)', { data: diff });
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
    const hash = await ctx.git.commit({ message: a.message, paths: a.paths });
    return hash
      ? ok(`Committed ${hash.slice(0, 8)}: ${a.message}`, { data: hash })
      : ok('Nothing to commit.');
  },
};

const gitRevertTool: Tool<{ ref: string }> = {
  name       : 'git_revert',
  description: 'Revert a commit (new commit undoing it). Always confirmed.',
  mutating   : true,
  confirm    : true,
  args       : z.object({ ref: z.string().min(1) }),
  async run(a, ctx) {
    await ctx.git.revert(a.ref);
    return ok(`Reverted ${a.ref}.`);
  },
};

const gitRestoreTool: Tool<{ path: string; ref?: string }> = {
  name       : 'git_restore',
  description: 'Restore a file to an earlier commit. Always confirmed.',
  mutating   : true,
  confirm    : true,
  args       : z.object({ path: z.string().min(1), ref: z.string().optional() }),
  async run(a, ctx) {
    await ctx.git.restore(a.path, a.ref ?? 'HEAD');
    return ok(`Restored ${a.path} to ${a.ref ?? 'HEAD'}.`);
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
  gitInitTool,
};
