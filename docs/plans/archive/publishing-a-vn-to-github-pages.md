# Publish a VN as a light-novel web page via GitHub Pages

## Context

The pipeline stops at `manifest.json`, and `@vn/export` projects that into
`vngen/build/story.play.json` — an ordered beat list per scene (`show` / `say` / `narrate`) plus
branch edges. That structure is already a light novel; nothing renders it as one, and there is no
way to put a generated VN on the web at all.

The goal is one menu entry in the desktop app that installs a GitHub Actions workflow into the
author's project repo, so that pushing the repo publishes the story as a static site on GitHub
Pages. Decisions already taken:

- **Gamebook, not linearized** — one HTML page per scene, `choices` and `next` render as links.
- **No prose voice.** `say` beats render mechanically (speaker + line). No LLM pass, no
  screenplay-to-prose rewriting.
- **CI renders the site; the app does not commit HTML.** Every package here is `private: true`, so
  CI cannot `npx vngen`. Instead the app commits a self-contained bundled renderer into the
  project repo and the workflow runs it with plain `node`, no install. One source for the
  renderer, no duplicated image bytes in git, and re-exporting + pushing republishes without the
  app being involved.
- **The app commits but never pushes.** `@vn/git` has no `push`, no `remote`, and no branch
  create/switch, and this plan adds none. Commit-on-save handles the commit; the author pushes.
- **The workflow writes a `gh-pages` branch** rather than deploying to Pages directly, so what is
  published is a branch the author can see and inspect.

## Approach

### 1. The renderer — `packages/export/src/site.ts` (new)

Pure, no fs. `@vn/export` is a boundaries-constrained leaf (`@vn/types`, `@vn/store`, `@vn/util`
only); this adds no imports.

```ts
export interface SitePage { path: string; html: string }
export interface SiteBuild { pages: SitePage[]; assets: { hash: string; ext: string }[] }
export function renderSite(playable: Playable): SiteBuild
```

Consumes `Playable` from `packages/types/src/playable.ts` — do **not** re-walk `Scene`/`Shot`.
`buildPlayable` (`packages/export/src/playable.ts:165`) has already applied the coverage rules
(first shot covering a line wins, `transition` lines emit no beat, absent assets omitted).

Emits:

- `index.html` — title plus a table of contents, entry scene first.
- `<sceneId>.html` per scene: beats in order, then the branch footer.
- `style.css` — one stylesheet, no JS, no external requests.

Beat rendering, all of it mechanical:

- `show` → `<figure><img src="assets/<hash>.<ext>">`, **skipped entirely when `image` is absent**
  (a partially generated project still publishes).
- `narrate` → `<p class="narrate">`.
- `say` → `<p class="say"><span class="who">Name</span> “text”</p>`, name from
  `playable.characters[who]?.name` falling back to the raw `who` key.
- Footer: `choices` as a list of `<a href="<goto>.html">label</a>`; otherwise `next` as a single
  continue link; otherwise nothing (an ending).

Escape every authored string into HTML. Scene ids come from the model and are already
id-shaped, but sanitize them into filenames anyway rather than trusting them.

`assets` is the deduped set of every `image` ref reached, plus each character `portrait` if
`playable.portraitOverlay` is set — the copy list for the caller.

Tests at `packages/export/src/tests/site.test.ts` (the repo silently never runs a `*.test.ts`
outside a `tests/` sibling): beat-to-markup for each variant, an image-less `show`, a scene with
choices vs. one with `next` vs. an ending, escaping, and the asset set being deduped.

### 2. The standalone entry — `packages/export/src/site-cli.ts` (new)

Not re-exported from `index.ts`; it exists to be bundled.

`node vn-site.mjs [--project <dir>] [--out <dir>]` (defaults `.` and `<project>/vngen/build/site`):

1. Read `<project>/vngen/build/story.play.json`, parse through the `playableSchema` zod schema in
   `@vn/types` — validation at the boundary, per the repo convention.
2. `renderSite`, write the pages.
3. Copy each asset to `<out>/assets/<hash>.<ext>`, resolving the two roots the way
   `AssetStore.rootHolding` does (`packages/store/src/assetstore.ts:275`): try
   `vngen/build/assets/` then `assets/objects/`. A ref found in neither is a warning on stderr,
   not a failure — the same "a missing asset is omitted, not an error" rule the exporter follows.
4. Write `.nojekyll` (GitHub Pages otherwise runs Jekyll, which drops paths beginning with `_`).

Exit non-zero only when `story.play.json` is missing or fails the schema.

### 3. Bundling — `scripts/esbuild.sitebuilder.mjs` (new)

Modelled on `scripts/esbuild.cli.mjs`. Entry `packages/export/src/site-cli.ts`, outfile
**`apps/desktop/dist/main/vn-site.mjs`**, `bundle: true`, `platform: node`, `format: esm`,
`target: node20`, no externals, **no sourcemap and no minify** — this file lands in someone's git
history, so it should diff as ordinary lines.

Output goes beside `dist/main/index.cjs` deliberately: `apps/desktop/dist` is copied wholesale by
`scripts/package.desktop.mjs:81`, so the bundle ships in the installer with no packaging change,
and `join(__dirname, 'vn-site.mjs')` resolves in both a checkout and a packaged build. Add the
script to `apps/desktop/package.json`'s `build` so `pnpm build` and `pnpm package` both produce it.

### 4. Install logic — `apps/desktop/src/main/pages.ts` (new)

- `sitebuilderPath()` — `join(__dirname, 'vn-site.mjs')`, falling back to the repo-root path for
  jest (which runs under plain node). Fails by name if absent, the way
  `readResource` (`apps/desktop/src/main/resources.ts:38`) does: a packaging mistake must not
  surface as a bare ENOENT.
- `workflowYaml(branch, publishBranch)` — the workflow text, with the repo's **current** branch
  substituted into `on: push:` so a `main` repo and a `master` repo both work. Read it with
  `git.branch()` (`packages/git/src/git.ts:148`) at install time.
- `installPages(root, opts)` — writes the two files with `writeFileAtomic`, returns their
  workspace-relative paths.

Destinations in the project repo:

| File | Why there |
| --- | --- |
| `.vnstudio/pages/vn-site.mjs` | `.vnstudio/` is already where app-owned project files live (layout templates) |
| `.github/workflows/vn-pages.yml` | the only place GitHub looks |

The workflow, using only `actions/checkout` and `actions/setup-node` — no third-party action:

```yaml
name: Publish VN to GitHub Pages
on:
  push:
    branches: [<the repo's branch at install time>]
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: vn-pages
  cancel-in-progress: true
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Render and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          out="$RUNNER_TEMP/site"
          node .vnstudio/pages/vn-site.mjs --project . --out "$out"
          cd "$out"
          git init -q -b gh-pages
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -q -m "Publish site from ${GITHUB_SHA}"
          git push -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" gh-pages
```

A force-pushed single-commit orphan branch, deliberately: `gh-pages` holds a full copy of every
image, and keeping its history would grow the repo by that much on every publish.

### 5. The commands — `apps/desktop/src/main/commands/project.ts`

Reuse the existing `project` namespace; `commands.test.ts:18-38` pins the namespace list, so a new
one would mean editing that array for no gain.

**`project.pagesStatus`** — `mutating: false`. Returns
`{ installed: boolean; branch: string; remote: string | null; playable: boolean }`. The remote
comes from `git.configGet('remote.origin.url')` (`packages/git/src/git.ts:141`) — no new `@vn/git`
capability needed. Feeds the menu label and the dialog's note.

**`project.installPages`** — `mutating: true`, `confirm: true`, **not** `undoable` (it writes
outside the document tree the undo snapshot covers; state the reason in the module comment the way
`upload.ts:1-11` does). Props: `branch` = `prop.string('the branch the workflow publishes to', { default: 'gh-pages' })`.

`check` refuses, in this order, with the sentence `run` re-derives:

1. not a git repo (`git.isRepo()`),
2. no `remote.origin.url`,
3. a run in progress (`ctx.host.session.busy()`).

On accept the note names what it writes and whether it is an install or an update.

`run`:

1. `ctx.host.session.writePlayable()` (`apps/desktop/src/main/session.ts:4028`) — export first, so
   the commit it makes is one CI can actually build from. Without this, install succeeds and the
   first Action run fails on a missing `story.play.json`.
2. `installPages(...)`.
3. `notify({ category: 'workspace', ... })` with the two remaining manual steps: push, then
   **Settings ▸ Pages ▸ Deploy from a branch ▸ `gh-pages` / `/ (root)`**. Stated as text, not a
   link — `NotificationInput.link` names an editor or a command, never a URL, and the app does not
   open addresses it was handed.
4. Return `{ message, data, written: ['.github/workflows/vn-pages.yml', '.vnstudio/pages/vn-site.mjs', 'vngen/build/story.play.json'] }`.

No commit code: `CommandStack.exec` runs the `Committer` for any `mutating` command
(`packages/commands/src/stack.ts:130`), committing `-A` per repo with `Vn-Command` trailers.

Register both in `apps/desktop/src/main/commands/index.ts`, and add `project.installPages` to the
pinned mutating-id list in `apps/desktop/src/main/commands/tests/commands.test.ts:60-123`.

### 6. The menu — `apps/desktop/renderer/pathux/editors/header.ts`

There is no File menu; the bar is VN STUDIO / View / Edit / Help (`header.ts:235-243`), and
**VN STUDIO is the de-facto File menu** — New Project, Open Project, Upload Files all live there.
Add the entry to `appMenu()` (`header.ts:393`), after `Upload Files…`, in object form with a
tooltip (every interactive element carries one):

```ts
{
  name: this.pagesInstalled ? 'Update GitHub Page Builder…' : 'Install GitHub Page Builder…',
  callback: () => openCommandDialog('project.installPages'),
  tooltip: 'Write a GitHub Actions workflow into this project that publishes it as a web page',
}
```

`openCommandDialog` rather than `act`, per the convention that a `confirm: true` command is formed
rather than fired.

`pagesInstalled` is fetched the way `refreshLayouts` (`header.ts:217`) fetches templates: a
`refreshPages()` keyed on `${this.ui.projectRoot}|${this.layoutRevision}`, calling
`exec('project.pagesStatus')` and `rebuild()`-ing. The revision is bumped by the existing
`onInvalidate` watch, so installing updates the label without a special case. Add a
`pagesRevision`-free `this.pagesInstalled` to `stateKey()` so the bar redraws.

### 7. Docs

- `docs/reference/playable-format.md` — a section on the web export: what CI runs, what lands in
  the project repo, why the renderer is committed as a bundle.
- `docs/reference/command-system.md` — the two new rows in the command table (~lines 298-378), then
  `pnpm build:catalog`.
- `CLAUDE.md` — one bullet under "Playable & desktop app".
- Per `docs/reference/conventions.md`, file a copy of this plan under `docs/plans/` and have a
  fresh-context agent attack it before the work starts; record each finding's resolution in the
  file.

## Verification

1. `pnpm check && pnpm test && pnpm lint` green, plus `pnpm build` producing
   `apps/desktop/dist/main/vn-site.mjs`.
2. **Renderer, offline.** In `examples/test4` (real project, 520 generated PNGs, no
   `story.play.json` yet): `node apps/cli/dist/cli.js export examples/test4`, then
   `node apps/desktop/dist/main/vn-site.mjs --project examples/test4 --out <scratch>/site`. Serve
   it and click through — every `show` beat with an image must render a picture, and following
   choices must land on real pages rather than 404s. A page whose images are all missing means the
   shots were reconstructed rather than loaded; check `loadSceneShots` ran.
3. **The command, live.** `pnpm vndesktop` on `examples/test4`, VN STUDIO ▸ Install GitHub Page
   Builder…, confirm. Check the two files exist, that `git log` in `examples/test4` shows one
   commit carrying them with `Vn-Command: project.installPages`, and that reopening the menu now
   reads **Update**. Surfaces are verified over CDP (`node scripts/vn-cdp.mjs`), since the jest
   desktop project is node-only.
4. **End to end.** Push `examples/test4` to `origin`
   (`https://github.com/joeedh/test-visual-novel-1.git`), watch the Action, confirm a `gh-pages`
   branch appears with `index.html` and `assets/`. Then enable Pages in repo settings and load the
   published URL.
5. Re-run install on the already-installed project and confirm it overwrites cleanly and produces
   a second commit.

## As shipped

Built as planned. Six things ended up different from the text above.

- **`site-cli.ts` validates by hand rather than through `playableSchema`.** The plan called for
  zod at the boundary, per the repo convention. Measured, zod takes the bundle from 275 lines to
  4,688 — and this file is committed to an author's git history and rewritten whole on every
  reinstall. `asPlayable` checks the fields `renderSite` reads and names the bad one. The reason is
  recorded on the function.
- **The workflow refuses a `gh-pages` it did not write.** Every published site carries a
  `.vn-pages` marker at its root, and the workflow checks for it before force-pushing, so
  installing this cannot destroy a branch somebody built by hand. The plan's force-push had no
  guard.
- **`.gitattributes` was in scope after all.** The plan left it out; the committed bundle gets
  `${SITEBUILDER_FILE} -merge` for the same reason layout templates do — a three-way merge of two
  builds' output produces a file neither build wrote.
- **`pagesStatus` reports staleness, and the menu label comes from it.** Staleness is decided by
  comparing bytes against the shipped bundle, which also catches a hand-edited copy. The plan only
  had `installed`.
- **The bundle carries `/* eslint-disable */`**, and this repo ignores `**/.vnstudio/pages/**`.
  See finding 25.
- **`publishBranch` is a prop with a `gh-pages` default**, and `concurrency` does not cancel a run
  in progress — cancelling one mid-push could leave the published branch half-written.

Verified end to end against `examples/test4`: install and reinstall over CDP, each producing one
commit with `Vn-Command: project.installPages`; the Action green at 54 pages and 141/141 assets;
and a `gh-pages` branch carrying `index.html`, `assets/`, `.nojekyll` and `.vn-pages`. Enabling
Pages in the repository's settings is still the author's own step, and had not been done when this
was written.

## Risks worth stating

- **A committed build artifact.** `.vnstudio/pages/vn-site.mjs` is generated output living in the
  author's repo, and it goes stale when the app updates. Re-running the command refreshes it,
  which is what "Update GitHub Page Builder" is for — but nothing prompts the author to do it.
- **`examples/test4`'s remote is HTTPS**, so the manual push in step 4 needs a credential helper
  or a PAT already configured on this machine.
- **Pages on a private repo needs a paid plan.** If `test-visual-novel-1` is private and the
  account is free, the Action will succeed and the site will still 404.
- `.gitattributes` in the project repo marks layout templates `-merge`; the bundle arguably wants
  the same treatment. Left out of scope — mention it if merge conflicts show up.

## Review

A fresh-context agent attacked this plan. Every finding is recorded below with what was done
about it. Findings that changed the design are marked **changed**; findings that were wrong or
accepted as-is say so and why.

### Factual corrections to the plan

1. **`session.writePlayable()` does not exist. — changed.** The method is
   `WorkspaceSession.exportPlayable()`, which returns `{ path, scenes }`; `writePlayable` is a
   function in `@vn/export` that nothing in the app calls. `project.installPages` calls
   `exportPlayable()`.
2. **The asset-root order was stated backwards. — changed.** `AssetStore.rootHolding` tries the
   **base** root first, not the project root. `site-cli.ts` now tries them in that order, and its
   comment no longer claims to mirror code it did not mirror. For content-addressed hashes the two
   orders agree, so this was a documentation bug rather than a live one.
3. **`refreshLayouts` is keyed on `projectTitle`, not `projectRoot`.** The plan presented keying
   on the root as copying an existing pattern when it was changing one. `refreshPages` keys on the
   root deliberately, for the reason `refreshRecents` gives in its own comment: two projects may
   share a title. Stated in the comment rather than left to look like a copy.
4. **The boundaries allow-list for `@vn/export` is wider than the plan said** — `eslint.config.mjs`
   grants `types, util, parse, model, store`. No consequence: the new modules import fewer packages
   than the plan assumed, and `node:fs` is unclassified by the rule.
5. **`examples/test4` tracks 510 asset files, not 520.** Corrected here; the number was decorative.

### Design changes

6. **The committed bundle carried zod: 4,688 lines. — changed.** `playableSchema` pulled zod into
   a file that lands in an author's git repository, where every reinstall rewrites the whole thing
   as one diff. `site-cli.ts` now validates with a hand-written `asPlayable` that names the bad
   field. The bundle is **275 lines / 9.2 KB**, a 16× reduction. This is a deliberate exception to
   the repo's "validate at the boundary through `@vn/types`" rule, recorded in
   `docs/reference/playable-format.md` and in the function's own doc comment. The input is a file
   the same toolchain wrote one step earlier.
7. **A force-push could destroy a hand-built `gh-pages`. — changed.** This was the least reversible
   thing in the plan and it was not in the risk list. Every site the renderer writes now carries a
   `.vn-pages` marker at the root, and the workflow fetches the publish branch and refuses the run
   with a named error if the branch exists without one.
8. **The stated reason for force-pushing was wrong. — changed.** Git dedupes blobs by content, so
   republishing unchanged images does not re-store them; keeping history would not grow the repo by
   a full copy per publish. The decision stands, with the true reason: the published branch is a
   rendering rather than a history, and nothing reads its past commits.
9. **`concurrency` was not keyed on the ref. — changed.** A `workflow_dispatch` would have
   cancelled an in-flight push. Now `group: vn-pages-${{ github.ref }}` with
   `cancel-in-progress: false`, because cancelling a publish halfway is worse than queueing it.
10. **`git.branch()` answers `HEAD` on a detached or unborn checkout. — changed.** That would have
    installed a trigger that never fires, silently. `project.installPages` refuses with "This
    repository has no branch checked out yet."
11. **`site.ts` re-exported from the package barrel pulled a stylesheet and an HTML template into
    the desktop main bundle. — changed.** It is no longer in `index.ts`; `site-cli.ts` imports it
    directly. The reviewer's stronger recommendation — move both modules to a new `apps/` element —
    was not taken: the renderer is a projection of the playable and belongs beside the projection
    that produces it, and a new package would need a boundaries element, an alias and a tsconfig to
    buy one import less.
12. **`sitebuilderPath()` made `pnpm test` depend on `pnpm build`. — changed.** `pages.test.ts`
    skips the two suites that need the bundle when it is absent, the way `commands.test.ts` skips
    its generated-catalog test. The pure `workflowYaml` tests always run.
13. **The dev loop never built the site builder. — changed.** `esbuild.desktop.mjs` now imports
    `sitebuilderOptions` and builds it alongside main and preload, so `pnpm build:main` and the
    `--watch` dev loop both leave a current copy where `pages.ts` looks.
14. **Nothing told an author their committed bundle was stale. — changed.** `pagesState` compares
    the installed bytes against this build's, and the installed workflow against the one this build
    would write. Comparing bytes rather than a version stamp also catches a hand-edited copy, which
    is honest: reinstalling would overwrite it.
15. **`.gitattributes` was deferred. — changed.** `installPages` appends
    `.vnstudio/pages/vn-site.mjs -merge` if it is not already there. A generated file that
    three-way-merges produces one neither build wrote, which is exactly what the layout templates'
    `-merge` exists to prevent; the mechanism was already in the project.
16. **`commands.test.ts` pins four lists, not one. — changed.** `project.installPages` was added to
    the mutating list and to the `check` list. It is correctly absent from the undoable list and
    from the checked-non-mutator list.

### Accepted without change

17. **Undo cost.** `project.installPages` is not undoable, there is no uninstall command, and the
    commit-on-save commit is `-A`, so it can sweep unrelated dirty files in. Removing the feature is
    a `git rm` of two paths. Documented in `docs/guides/github-pages.md` and in the command's own
    description rather than solved: an uninstall command for two files is ceremony.
18. **The trigger branch is frozen at install time.** A later default-branch rename stops publishing
    with no signal. Documented; detecting it would mean the app watching a repository it does not
    otherwise watch.
19. **`actions/setup-node@v4` is dead weight** on `ubuntu-latest`. Kept: it pins the Node major the
    bundle targets, so a runner image changing its default cannot silently change what runs.
20. **`permissions: contents: write` grants write to the whole repository** for that job. There is
    no narrower scope for pushing a branch. Left as-is.
21. **No LFS handling.** `actions/checkout` does not fetch LFS by default and no project here uses
    it. Latent, not live.
22. **`apps/cli` has no `site` subcommand.** Deliberate: the renderer's home is the desktop app's
    `dist/`, because installing it into a project is the only thing that reads it. The guide shows
    how to run the bundle directly from a checkout.
23. **`pagesStatus` returning a playable flag duplicated `story.export`'s check.** Dropped — the
    status now returns `installed`, `stale`, `repo`, `branch`, `onBranch` and `remote`, and the
    export happens inside `installPages` rather than being reported ahead of it.
24. **`join(__dirname, 'vn-site.mjs')` inside an asar.** Verified correct: Electron patches `fs`, so
    reading works. Noted in `pages.ts` that spawning it would not, which is why nothing does.

### Found during verification

25. **The committed bundle gets linted.** `examples/test4` lives inside this repo, so `eslint .`
    read the installed `.vnstudio/pages/vn-site.mjs` and failed on `no-empty` in esbuild's output.
    Any author whose project sits in a linted repository would hit the same thing. Two fixes: the
    bundle's banner now carries `/* eslint-disable */`, which travels with the file into whatever
    repository it lands in, and this repo also ignores `**/.vnstudio/pages/**` so an older
    installed copy stays quiet.

### House voice

The reviewer flagged the plan and the drafted comments for the aphoristic register commit
`a73e8c68` removed. `site.ts`'s "the story is a graph and a book is a line", the trailing "and it
does so by name alone", and `site-cli.ts`'s fourteen-line packaging narration were rewritten as
plain declarative prose. This plan's own prose was left as written — it is a record of a decision,
not code someone has to read while debugging.
