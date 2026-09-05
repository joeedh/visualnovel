/**
 * Commands for the project's own settings: reading what `project.yaml` says, and writing the one
 * field in it an author edits often enough to want a pane for.
 *
 * The art style is not like the other settings. It is the first clause of every image prompt and
 * is folded into every image task's hash, so changing it re-keys the whole library and the next
 * run draws it all again. That is why the write is `confirm: true` and why its check counts what
 * it would touch.
 *
 * `project.installPages` is `mutating` but not `undoable`. It writes `.github/` and `.vnstudio/`,
 * which are outside the document tree an undo snapshot covers, and removing it again is a
 * `git rm` of two paths rather than a state the app models.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import { KEY_VENDORS } from '@vn/config';
import { openGit } from '@vn/git';
import { notify } from '../notifications.js';
import { installPages, pagesState } from '../pages.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** Converts a session preview into a `CheckResult`, keeping the session's message in both cases. */
function verdict(result: { ok: boolean; message: string }): CheckResult {
  return result.ok ? { ok: true, note: result.message } : { ok: false, reason: result.message };
}

export const projectInfo = define({
  id         : 'project.info',
  title      : 'Project settings',
  description:
    'What `project.yaml` says: the title, the entry scene, the art style, the model ids and the ' +
    'image parameters — plus how many image tasks the art style reaches. Never the API keys, ' +
    'whose names live in the file and whose values never leave the environment.',
  notes:
    'What `project.yaml` says: title, entry scene, art style, model ids, image params, and how many image tasks the art style reaches. Never the API keys — their *names* are in the file and a pane listing them is one screenshot away from looking like it lists their values.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const view = await ctx.host.session.projectView();
    return { message: `${view.title} — ${view.imageTasks} image task(s).`, data: view };
  },
});

export const projectSetArtStyle = define({
  id         : 'project.setArtStyle',
  title      : 'Set the art style',
  description:
    "Set the project's art style — the sentence every image prompt opens with. It is not art " +
    'notes on one rung: it reaches every portrait, sheet, plate and shot, so setting it re-keys ' +
    'every image task and the next `pipeline.run` renders the whole library again. The line is ' +
    'spliced into `project.yaml`, so comments and key order survive.',
  notes:
    'The sentence every image prompt opens with. Not art notes on one rung: it reaches every portrait, sheet, plate and shot, so it re-keys **every** image task. Spliced into `project.yaml`, so comments and key order survive.',
  mutating   : true,
  undoable   : true,
  // Every other document mutator changes one document's words. This one changes what the project
  // looks like, and the next run redraws the whole library for it.
  confirm    : true,
  props: {
    style: prop.string('the art style; empty clears it', { default: '' }),
  },
  async check({ style }, ctx) {
    return verdict(await ctx.host.session.previewArtStyle(style));
  },
  async run({ style }, ctx) {
    const result = await ctx.host.session.setProjectArtStyle(style);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, data: result, written: result.written };
  },
});

/** The two key sources an author can write to. Ordered so the enum's first value is the default. */
const KEY_SCOPES = ['project', 'user'] as const;

export const projectSetKey = define({
  id         : 'project.setKey',
  title      : 'Provide a model key',
  description:
    'Store an API key for one model provider — the file `resolveKeys` reads when the matching ' +
    'environment variable is unset. `scope=project` writes it into this project (`keys/`, added ' +
    'to `.gitignore` before the write so commit-on-save cannot pick it up); `scope=user` writes ' +
    'it once for every project on this machine, into a directory no repository contains. Either ' +
    'way the value reaches that file and nowhere else: the history records `<secret>`.',
  notes:
    "Store one model provider's API key in `keys/`, the file `resolveKeys` reads when the matching environment variable is unset — and it says so when one is set, because the variable wins. The value goes to that file and nowhere else: the history records `<secret>`, and `keys` is added to `.gitignore` **before** the write, because commit-on-save runs `git commit -A`. Deliberately **not undoable**: `keys/` is outside the class a snapshot covers, which is what keeps an undo from writing over or deleting the credential this command exists to store.",
  mutating   : true,
  // Deliberately not undoable: an undo point is a git snapshot, and this command exists to keep
  // the credential out of git. At the user scope the file is not in a repository at all, so no
  // snapshot is possible.
  undoable   : false,
  props: {
    provider: prop.oneOf(KEY_VENDORS, 'which model provider the key is for'),
    key     : prop.secret('the API key; it is written to a gitignored file and never recorded'),
    scope: prop.oneOf(
      KEY_SCOPES,
      'where the key is written: in this project, or once for every project on this machine',
      { default: 'project' },
    ),
  },
  async check({ provider, scope }, ctx) {
    return verdict(await ctx.host.session.previewKey(provider, scope));
  },
  async run({ provider, key, scope }, ctx) {
    const result = await ctx.host.session.setKey(provider, key, scope);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, written: result.written };
  },
});

export const projectTestKey = define({
  id         : 'project.testKey',
  title      : 'Test a model key',
  description:
    'Make one small real call with a provider’s key and say whether it worked. This is the ' +
    'question `project.keyStatus` cannot answer: a key can resolve and still be revoked, ' +
    'mistyped, or on an account with no credit, and without this the first news of that arrives ' +
    'much later as a run failing. It costs a fraction of a cent, and under `--mock` it does ' +
    'nothing, because a mock run never calls a provider.',
  // Writes nothing of its own. It does spend money, which the description states so that an author
  // is not left to infer the cost.
  mutating   : false,
  props: {
    provider: prop.oneOf(KEY_VENDORS, 'which provider’s key to try'),
  },
  async check({ provider }, ctx) {
    return verdict(await ctx.host.session.previewTestKey(provider));
  },
  async run({ provider }, ctx) {
    const result = await ctx.host.session.testKey(provider);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message };
  },
});

export const projectKeyStatus = define({
  id         : 'project.keyStatus',
  title      : 'Which model keys are set',
  description:
    'For each model provider, whether a key resolved and **which source** answered — an ' +
    'environment variable by name, this project’s `keys/`, an enclosing repository’s, or the ' +
    'user-level one. Never the key itself. It is also the honest answer to “why is it still ' +
    'asking me”: a set environment variable is read before every file, so it shadows one that ' +
    'was just pasted.',
  mutating   : false,
  props      : {},
  async run(_props, ctx) {
    const view = await ctx.host.session.keyStatusView();
    const missing = view.vendors.filter((v) => !v.resolved).map((v) => v.vendor);
    return {
      message:
        missing.length === 0 ? 'Every provider has a key.' : `No key for ${missing.join(', ')}.`,
      data   : view,
    };
  },
});

/**
 * Whether this project can publish, and whether it already does. Shared by `project.pagesStatus`
 * and `project.installPages` so the menu label, the refusal and the confirmation note cannot
 * disagree about what is installed.
 */
async function pagesView(ctx: { host: CommandHost }, publishBranch: string) {
  const root = ctx.host.session.dir;
  const git = openGit(root);
  const repo = await git.isRepo();
  const branch = repo ? await git.branch() : '';
  const remote = repo ? await git.configGet('remote.origin.url') : null;
  // `git.branch()` answers `HEAD` on a detached or unborn checkout. A workflow triggered on a
  // branch called HEAD would install without complaint and then never fire.
  const onBranch = branch !== '' && branch !== 'HEAD';
  const state =
    repo && onBranch
      ? await pagesState(root, { branch, publishBranch })
      : { installed: false, stale: false };
  return { repo, branch, onBranch, remote, ...state };
}

export const projectPagesStatus = define({
  id         : 'project.pagesStatus',
  title      : 'GitHub Pages status',
  description:
    'Whether this project carries the GitHub Pages publisher, whether it came from this build ' +
    'of the app, and what the repository would publish from.',
  notes:
    'Whether this project carries the GitHub page builder, and whether the copy it carries came from this build of the app. Read by the menu, which reads Install or Update accordingly.',
  mutating   : false,
  props: {
    branch: prop.string('The branch the workflow publishes the site to.', {
      default: 'gh-pages',
    }),
  },
  async run(props, ctx) {
    const view = await pagesView(ctx, props.branch);
    const message = view.installed
      ? view.stale
        ? 'The page builder is installed, from a different build of the app.'
        : 'The page builder is installed and up to date.'
      : 'The page builder is not installed.';
    // Nothing here can see whether Pages is switched on: it is a repository setting, and the app
    // never talks to GitHub. What is installed says nothing about what is served, so the answer
    // names the setting rather than implying the site is up.
    const serving = view.installed
      ? ` Serving it needs Settings ▸ Pages on GitHub set to deploy from ${props.branch} at the root.`
      : '';
    return { message: `${message}${serving}`, data: view };
  },
});

export const projectInstallPages = define({
  id         : 'project.installPages',
  title      : 'Install the GitHub page builder',
  description:
    'Write a GitHub Actions workflow into this project that publishes it as a light-novel web ' +
    'page. The workflow and the renderer it runs are committed to the project repository; ' +
    'pushing the repository then publishes the site to a branch GitHub Pages can serve.',
  notes:
    'Write a GitHub Actions workflow into the project that publishes it as a light-novel web page, plus the bundled renderer the workflow runs. Refuses a project that is not a git repository, has no branch checked out, or has no `origin` remote. Exports the playable first, so the commit CI builds from is complete. Deliberately **not undoable**: it writes `.github/` and `.vnstudio/`, outside the tree the undo snapshot covers. The app never pushes. See [`../guides/github-pages.md`](../guides/github-pages.md).',
  mutating   : true,
  confirm    : true,
  props: {
    branch: prop.string('The branch the workflow publishes the site to.', {
      default: 'gh-pages',
    }),
  },
  async check(props, ctx) {
    const busy = ctx.host.session.busy();
    if (busy) return { ok: false, reason: `${busy} is still running; wait for it to finish.` };
    const view = await pagesView(ctx, props.branch);
    if (!view.repo) {
      return {
        ok    : false,
        reason: 'This project is not a git repository, so there is nothing to publish from.',
      };
    }
    if (!view.onBranch) {
      return {
        ok    : false,
        reason:
          'This repository has no branch checked out yet. Make a commit first, then install the page builder.',
      };
    }
    if (!view.remote) {
      return {
        ok    : false,
        reason:
          'This repository has no `origin` remote. Add one on GitHub, then install the page builder.',
      };
    }
    const verb = view.installed ? 'Updates' : 'Installs';
    return {
      ok  : true,
      note:
        `${verb} the workflow and the renderer, and exports the playable. Pushing ${view.branch} ` +
        `then publishes the site to ${props.branch}. Serving it is a setting only you can change: ` +
        `Settings ▸ Pages on GitHub, deploying from ${props.branch} at the root.`,
    };
  },
  async run(props, ctx) {
    const view = await pagesView(ctx, props.branch);
    // Export first. Without a `story.play.json` in the same commit, the first Action run fails on
    // a file the author has no reason to know about.
    const { scenes } = await ctx.host.session.exportPlayable();
    const written = await installPages(ctx.host.session.dir, {
      branch       : view.branch,
      publishBranch: props.branch,
    });

    // The second step is a GitHub setting nothing here can reach, and skipping it fails quietly:
    // the workflow goes green and the address 404s. The notification is durable, so it is still
    // there to read when the push finishes.
    await notify({
      category: 'workspace',
      message:
        `The GitHub page builder is installed. Two steps remain, both on GitHub. ` +
        `1. Push ${view.branch} to origin — that is what runs the workflow. ` +
        `2. Open the repository on github.com and go to Settings ▸ Pages, set Source to ` +
        `"Deploy from a branch", pick ${props.branch} with the folder "/ (root)", and Save. ` +
        `Until step 2 is done the workflow succeeds and the published address still 404s.`,
    });

    return {
      message: `${view.installed ? 'Updated' : 'Installed'} the page builder; exported ${scenes} scene(s).`,
      data   : { ...view, publishBranch: props.branch },
      written: [...written, 'vngen/build/story.play.json'],
    };
  },
});
