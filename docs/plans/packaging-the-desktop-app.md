# Packaging the desktop app

Status: **planned**. Plan 2 of [`shipping-the-app-tasklist.md`](shipping-the-app-tasklist.md).

Turning `apps/desktop` into an installer a stranger can double-click. The app currently runs
from a checkout, which means it has pnpm's symlinked `node_modules`, a git submodule at
`vendor/path.ux`, a repo root to resolve things against, and `git` on PATH because a developer
machine has git on PATH. A packaged app has none of those by default, and each one is a
decision below.

## The tool: electron-builder

Not Forge. The deciding reason is that electron-builder emits the `latest.yml` / `latest-mac.yml`
metadata that `electron-updater` consumes — so [`in-app-update-checks.md`](in-app-update-checks.md)
gets its feed from the same tool that made the installer, rather than from a second system that
has to be kept in agreement about what a version is.

Targets, in the order we care:

| Platform | Target             | Notes                                                          |
| -------- | ------------------ | -------------------------------------------------------------- |
| Windows  | NSIS installer      | The one that ships first                                        |
| macOS    | dmg + zip           | Deferred — unsigned mac builds are quarantined and effectively unopenable |
| Linux    | AppImage            | Cheap to add; `deb` is deliberately skipped, it cannot auto-update |

Config lives in `apps/desktop/electron-builder.yml` rather than in `package.json`, because it
will grow comments and the `files` list below is the part someone will need to read.

## What actually ships

This is the part that is unusual here, and it is unusually good news. `scripts/aliases.mjs`
declares only three externals:

```js
export const EXTERNAL = ['electron', '@google/genai', '@anthropic-ai/sdk'];
```

Everything else — every `@vn/*` package, all source-only, plus `nstructjs` and the whole of
path.ux — is **bundled into `dist/`** by esbuild and Vite. So the app image needs:

- `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/renderer/**`, `dist/commands.json`
- a real `node_modules` containing exactly **two** packages: `@google/genai` and
  `@anthropic-ai/sdk` (both lazily imported, both heavy, both correctly left external)
- `package.json`, for `main` and the version

and nothing else. Not `packages/`, not `vendor/`, not the pnpm store. The `files` list says so
explicitly rather than relying on a default glob:

```yaml
files:
  - dist/**
  - package.json
  - '!dist/pathux-types/**' # a tsgo artifact, not runtime
```

**`dist/pathux-types/` is build output that must not ship** — it exists so `renderer/tsconfig.json`
has declarations to check against, and it is in the same `dist/` the runtime files are in. Easy to
miss, hence the explicit exclusion.

### The pnpm problem

pnpm's default `node_modules` is a tree of symlinks into a content-addressed store. electron-builder
copies the module tree into the app image and does not reliably follow that layout — the classic
result is an app that launches and then throws `Cannot find module '@anthropic-ai/sdk'` the first
time someone runs the agent, which is *after* install and therefore after every smoke test that
only checks the window opens.

The fix, and it is the boring one: **package from a hoisted install.** The packaging step runs
`pnpm install --config.node-linker=hoisted` in a scratch directory containing just the app's
`package.json` with the two runtime dependencies, and points electron-builder at that. It does
not disturb the workspace's own `node_modules`.

Acceptance for this specifically: a smoke test that launches the packaged app and forces one
lazy import of each SDK. "The window opened" is not evidence.

### Resources that are not code

`docs/api-keys.md` — the onboarding walkthrough's single source, from
[`onboarding-editor-and-user-level-keys.md`](onboarding-editor-and-user-level-keys.md) — is
markdown outside `apps/desktop`. It ships as `extraResources`, and main reads it from
`process.resourcesPath` in production and from the repo in development. One helper,
`resourcePath(name)`, so exactly one place knows the difference.

## `git` is a runtime dependency, and the app must say so

`@vn/git` spawns `git` through `execFile`. Commit-on-save, `initRepoAt`, the undo journal's
shadow refs and the repo map all rest on it. On a machine without git, a packaged app does not
degrade — it fails at the first save, in a dialog nobody can act on.

**Decision: require it, and check at startup.** Do not bundle a portable git. On mac and Linux
git is effectively always present, and a bundled copy adds tens of megabytes plus a second thing
to keep patched, to solve a problem only Windows has — where the answer is a link to the
installer.

The check is a **runtime doctor**, deliberately named after `pnpm doctor`, which already does the
same job for the submodule:

- Runs once at startup, before any workspace opens.
- `git --version`; if it fails, a blocking dialog naming git, saying what stops working without
  it (saving, undo, project history), and offering a **Download git** button.
- Not fatal — the app opens read-only rather than refusing to start, because someone who wants to
  look at a generated VN should not need git to do it.
- It reports through the same notification hook everything else does, so the state is durable and
  visible after the dialog is dismissed.

The submodule is *not* a runtime concern: path.ux is compiled into the renderer bundle by Vite.
It matters only in CI, and [`release-ci-workflow.md`](release-ci-workflow.md) owns it.

## The version source of truth

Everything in this repo is `version: 0.0.0` today, and the update check needs a real one.

**Decision: `apps/desktop/package.json`'s `version` is the app version.** The root and the
`packages/*` are private, unpublished, and stay at `0.0.0` — versioning them is ceremony that
buys nothing, since nothing installs them by version.

- The tag drives the release: `v0.3.0`.
- CI **asserts** the tag matches `apps/desktop/package.json` rather than writing it. A workflow
  that edits versions has to commit, which means a release workflow that pushes to master, which
  is exactly the thing a linear history does not want.
- Bumping is therefore a normal commit, reviewed like any other, and the tag comes after.
- A dev build reports its version as the package version plus the short sha, so a bug report
  from someone running a build between releases says which one.

## Commands

- `pnpm package` — build, hoisted install, electron-builder for the host platform, no publish.
- `pnpm package:dir` — unpacked output only, for iterating without waiting on the installer.

Both live in `apps/desktop/package.json` alongside `build`, and `package` depends on `build`.

## Acceptance

- `pnpm package` on Windows produces an NSIS installer.
- A **clean VM** — no node, no pnpm, no repo — installs it and opens a project.
- The agent runs, which proves both external SDKs resolved.
- The app image contains no `packages/`, no `vendor/`, and no `pathux-types`.
- With git renamed off PATH, the app opens and says why saving is unavailable.
- `docs/api-keys.md` renders in the Setup pane from the packaged copy.

## Out of scope

Signing ([`code-signing-and-notarization.md`](code-signing-and-notarization.md)), CI
([`release-ci-workflow.md`](release-ci-workflow.md)), and auto-install updates
([`in-app-update-checks.md`](in-app-update-checks.md)).
