/**
 * The workspace as commands: which project is open, what is in it, the map the agent reads, and
 * the one-time migration into the chunk format.
 *
 * No mutator here is `undoable`. `workspace.import` restructures the whole worktree, which is what
 * a shadow snapshot is worst at, and the `.imported` rename it leaves behind is a reversal the
 * author can perform themselves; `workspace.reindex` writes one derived file, and undoing it means
 * running it again; and `workspace.open`/`pick` write into a *different* tree than the one the
 * undo journal snapshots, so a shadow ref in the old repo could not restore it anyway.
 */
import { resolve } from 'node:path';
import { defineFor, prop } from '@vn/commands';
import { GENERATED_CONTEXT_FILE } from '@vn/authoring';
import type { CommandHost } from './host.js';
import { inspectWorkspace, recentWorkspaces } from '../workspace.js';

const define = defineFor<CommandHost>();

/**
 * What opening `path` would do, in the sentence a refusal or a confirmation needs. Shared by
 * `workspace.open`'s check and `workspace.pick`, so the picker cannot accept what the command
 * would refuse.
 */
async function wouldOpen(
  path: string,
  current: string,
  busy: string | undefined,
): Promise<{ ok: true; note: string } | { ok: false; reason: string }> {
  const root = resolve(path);
  if (root === resolve(current)) return { ok: false, reason: `${root} is already open.` };
  if (busy) return { ok: false, reason: `${busy} is still running; wait for it to finish.` };

  const found = await inspectWorkspace(root);
  if (!found.directory) return { ok: false, reason: `${root} is not a directory.` };
  if (found.problem) return { ok: false, reason: found.problem };
  return {
    ok: true,
    note: found.project
      ? `Opens ${found.title ?? root}.`
      : `Creates a new project at ${root}: writes project.yaml and initializes a git repo.`,
  };
}

export const workspaceOpen = define({
  id: 'workspace.open',
  title: 'Open a project',
  description:
    'Open a project directory, making it one if it is not yet: writes a minimal project.yaml, ' +
    'initializes a git repository and commits whatever is already there. Closes the current ' +
    'project — its agent conversation and undo history go with it.',
  mutating: true,
  props: {
    path: prop.string('the project directory to open'),
  },
  check: (props, ctx) => wouldOpen(props.path, ctx.root, ctx.host.session.busy()),
  async run(props, ctx) {
    const opened = await ctx.host.openWorkspace(resolve(props.path));
    return { message: `Opened ${opened.title} (${opened.root}).` };
  },
});

export const workspacePick = define({
  id: 'workspace.pick',
  title: 'Open a project…',
  description:
    'Choose a project directory in a file dialog, then open it — `workspace.open` with the ' +
    'picker in front. Cancelling changes nothing.',
  mutating: true,
  props: {},
  async check(_props, ctx) {
    const busy = ctx.host.session.busy();
    return busy
      ? { ok: false as const, reason: `${busy} is still running; wait for it to finish.` }
      : { ok: true as const, note: 'Opens a directory chooser.' };
  },
  async run(_props, ctx) {
    const picked = await ctx.host.pickDirectory();
    if (!picked) return { message: 'Cancelled.' };

    // The dialog is not a permission: a folder the command would refuse is refused here too.
    const verdict = await wouldOpen(picked, ctx.root, ctx.host.session.busy());
    if (!verdict.ok) throw new Error(verdict.reason);
    const opened = await ctx.host.openWorkspace(resolve(picked));
    return { message: `Opened ${opened.title} (${opened.root}).` };
  },
});

export const workspaceRecent = define({
  id: 'workspace.recent',
  title: 'Recent projects',
  description:
    'The project that is open and the ones opened before it, most recent first. Remembered per ' +
    'install rather than per project — it has to be readable before any project is open.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const recent = recentWorkspaces(ctx.host.state);
    return {
      message: `${recent.length} remembered project(s); ${ctx.root} is open.`,
      data: { current: ctx.root, recent },
    };
  },
});

export const workspaceIndex = define({
  id: 'workspace.index',
  title: 'Workspace index',
  description: 'The project index: characters, locations, screenplay files, diagnostics.',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const index = await ctx.host.session.index();
    return { message: `Indexed ${ctx.root}.`, data: index };
  },
});

export const workspaceDoctree = define({
  id: 'workspace.doctree',
  title: 'Document tree',
  description:
    'The sidebar tree — story, scenes and their shots, characters, locations, the wiki, assets ' +
    'by kind — plus what each entity is attached to (its sheet, its art, its scenes and shots).',
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const tree = await ctx.host.session.docTree();
    const entities = Object.keys(tree.backlinks).length;
    return {
      message: `${tree.roots.length} branch(es), ${entities} linked entity(ies).`,
      data: tree,
    };
  },
});

export const workspaceFiletree = define({
  id: 'workspace.filetree',
  title: 'File tree',
  description:
    'Every file in the workspace as a tree, `.git` and `node_modules` excluded. The document ' +
    "tree's other mode: what is on disk rather than what the model made of it.",
  mutating: false,
  props: {},
  async run(_props, ctx) {
    const roots = await ctx.host.session.fileTree();
    return { message: `${roots.length} entr(ies) at the workspace root.`, data: roots };
  },
});

export const workspaceReindex = define({
  id: 'workspace.reindex',
  title: 'Regenerate the project map',
  description:
    "Rebuild AICONTEXT.generated.md: the cast, the locations, the story graph, and the bible's " +
    'table of contents — the map the authoring agent reads. Facts only, never file contents.',
  mutating: true,
  props: {},
  async check(_props, ctx) {
    const state = await ctx.host.session.generatedContext();
    if (state.exists && !state.generated) {
      return {
        ok: false,
        reason: `${GENERATED_CONTEXT_FILE} was not written by workspace.reindex — move or delete it first.`,
      };
    }
    return { ok: true, note: state.exists ? 'Replaces the current map.' : 'Writes a new map.' };
  },
  async run(_props, ctx) {
    const { counts } = await ctx.host.session.writeGeneratedContext();
    const summary =
      `${counts.characters} character(s), ${counts.locations} location(s), ` +
      `${counts.scenes} scene(s), ${counts.bible} bible note(s)`;
    return { message: `Mapped ${summary}.`, written: [GENERATED_CONTEXT_FILE] };
  },
});

export const workspaceImport = define({
  id: 'workspace.import',
  title: 'Import the screenplay',
  description:
    'Convert a screenplay/*.fountain project into one scenes/<id>.md chunk per scene — the ' +
    '`vngen import` equivalent. Refuses over existing chunks; the original is moved aside, ' +
    'not deleted.',
  mutating: true,
  props: {},
  async check(_props, ctx) {
    const preview = await ctx.host.session.previewImport();
    return preview.ok
      ? { ok: true, note: preview.message }
      : { ok: false, reason: preview.message };
  },
  async run(_props, ctx) {
    const result = await ctx.host.session.importScreenplay();
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, written: result.written };
  },
});
