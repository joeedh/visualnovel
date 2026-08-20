# Toolchain

How this monorepo is built, checked, tested and formatted — and where each choice
deliberately deviates from [`../plans/archive/initial-implementation.md`](../plans/archive/initial-implementation.md).
The day-to-day command table lives in [`../../CLAUDE.md`](../../CLAUDE.md); this is the "why it is
wired that way" companion.

<!-- toc -->

- [Typecheck](#typecheck)
- [Bundling](#bundling)
- [Packaging the desktop app](#packaging-the-desktop-app)
- [Adding a package](#adding-a-package)
- [Lint](#lint)
- [Test](#test)
- [Continuous integration](#continuous-integration)
- [Format and package manager](#format-and-package-manager)

<!-- tocstop -->

## Typecheck

- **Flat, not project-references.** `pnpm check` runs `tsgo --noEmit -p tsconfig.json` over
  the whole workspace, not `tsgo -b`. The root `tsconfig.json` maps every `@vn/*` package to
  its `src/index.ts` via **relative** `paths` (TypeScript 7 / `tsgo` removed `baseUrl`, so
  non-relative paths are rejected).
- **The renderer is checked by a second pass.** Root `tsconfig.json` includes only
  `*/src/**`, and the desktop renderer deliberately lives outside `src` (at
  `apps/desktop/renderer/**`) so the root check never sees its JSX. `pnpm check` is therefore
  `tsgo -p tsconfig.json && pnpm check:renderer`, the latter running
  `tsgo --noEmit -p renderer/tsconfig.json` in `apps/desktop`. Without that second pass
  nothing typechecks the renderer at all — `vite build` uses esbuild, which never checks.
  `renderer/tsconfig.json` has its own `paths` map; add `@vn/*` entries there as needed,
  relative-form only. Its `types` carries `node` and `jest` — renderer `tests/` siblings are
  typechecked by that pass, not the root one.
- **`tsgo`** comes from `@typescript/native-preview` (TS7 dev). `"jest"` is in
  `compilerOptions.types` so test globals typecheck.

## Bundling

- **`esbuild` transpiles; `tsgo` verifies.** esbuild never type-checks. It bundles the three
  apps (`scripts/esbuild.cli.mjs`, `scripts/esbuild.authoring.mjs`,
  `scripts/esbuild.desktop.mjs` — the last for the Electron main process and preload only;
  the renderer goes through vite), bundles the command catalog entrypoint
  (`scripts/gen-command-catalog.mjs`), and serves as the jest transform
  (`scripts/jest-esbuild.cjs`). Internal
  packages are **source-only** — no per-package `dist`; consumers import `src/index.ts`
  directly.
- **Relative imports carry an explicit `.js` extension.** The repo is ESM with
  `verbatimModuleSyntax`, so `./foo.js` is what a relative import of `foo.ts` is written as —
  esbuild and `tsgo` both resolve it, and jest's `moduleNameMapper` strips it back off. A
  bare `./foo` typechecks under the bundler resolver and then fails at runtime in the built app.
- **`turbo` orchestrates the bundles.** Each app owns a `build` script (`apps/cli`,
  `apps/authoring`, `apps/desktop`); `pnpm build` is `turbo run build` (all three), and
  `build:cli` / `build:authoring` / `build:desktop` are thin `--filter=…` wrappers for one app
  at a time. Because internal packages are source-only (no build task of their own), their
  sources can't be picked up via `dependsOn: ["^build"]` — so `turbo.json` lists
  `packages/*/src/**`, the esbuild scripts, and the tsconfigs as `globalDependencies`, which
  is what actually invalidates an app's cache. Outputs are `dist/**`; the local cache lives in
  `.turbo` (gitignored).
- **The desktop bundle has a third step, `build:catalog`.** `scripts/gen-command-catalog.mjs`
  bundles `apps/desktop/src/main/commands/catalog-entry.ts` and writes
  `apps/desktop/dist/commands.json` (see [`../reference/command-system.md`](../reference/command-system.md)). Both
  bundle scripts share one alias map, `scripts/aliases.mjs`, so their package lists can't
  drift.

## Packaging the desktop app

`pnpm package` (unpacked-only: `pnpm package:dir`) turns `apps/desktop` into an installer.
electron-builder does the work, configured in `apps/desktop/electron-builder.yml` — which carries
the comments explaining each choice, so read that file rather than this section for *why*. The
plan is [`../plans/archive/packaging-the-desktop-app.md`](../plans/archive/packaging-the-desktop-app.md). Four things
about how it fits the rest of the toolchain:

- **It packages from a scratch project, not from the workspace.** pnpm's `node_modules` is a farm
  of symlinks into a content-addressed store, and electron-builder does not reproduce that layout
  in an app image. So `scripts/package.desktop.mjs` assembles `apps/desktop/.package/` — a
  `package.json` naming only the two runtime dependencies, `dist/` beside it — and runs
  `pnpm install --ignore-workspace --config.node-linker=hoisted` there. The workspace's own
  `node_modules` is untouched. Both `.package/` and `release/` are gitignored.
- **Only two packages ship.** Everything under `packages/` plus `nstructjs` and the whole of
  path.ux is bundled into `dist/` by esbuild and vite; `scripts/aliases.mjs` leaves exactly
  `electron`, `@google/genai` and `@anthropic-ai/sdk` external. That is why the `files` list is
  written out rather than left to a default glob, and why it excludes `dist/pathux-types/` — a
  `tsgo` artifact that lands in the same `dist/` the runtime files do.
- **`pnpm smoke` runs the packaged executable.** Both SDKs are reached through a lazy `import()`
  at the moment a model is first called, so a packaging mistake that loses them yields an app that
  installs, opens, opens a project — and throws `Cannot find module` at the first agent turn,
  after every check that only watches for a window. `scripts/smoke.desktop.mjs` launches the built
  binary with `--smoke`, which forces one import of each and exits; `src/main/smoke.ts` holds the
  logic and its tests. It runs with the vendor key variables blanked, because a smoke test that
  quietly leans on the developer's key is not a test of the installer.
- **`apps/desktop/package.json`'s `version` is the app version.** The root and every package stay
  at `0.0.0` — they are private and unpublished, so versioning them buys nothing. A release tag is
  *asserted* against that field rather than written into it, and a build made between releases
  reports `0.1.0 (dev <sha>)` via `src/main/version.ts`. So cutting a release is two acts in
  order: bump that field in an ordinary reviewed commit, then tag it `v<version>` — and
  `release.yml`'s `version` job fails by name if the two disagree.

Two paths inside a packaged app are not what a checkout would suggest, and both cost an evening
once: `__dirname` resolves *inside* `app.asar`, which is a file — so anything derived from it and
then written to fails `ENOTDIR` (this is why the session store lives under `userConfigDir()`), and
`docs/api-keys.md` arrives as `extraResources` under `process.resourcesPath`, which is what
`src/main/resources.ts` looks at first.

## Adding a package

Four separate lists enumerate packages, and each one is resolved by a different tool — so a
package can typecheck, pass its tests, and still fail to bundle:

1. the root `tsconfig.json` `paths` map (what `tsgo` resolves),
2. `PACKAGES` in `jest.config.cjs` (the display-named project; a project with no matching tests
   fails `pnpm test`, so add it in the same commit as the code),
3. `ALLOWED` + `boundaries/elements` in `eslint.config.mjs` (the layer and its allow-list),
4. `PACKAGES` in `scripts/aliases.mjs` (what esbuild resolves, for both bundle scripts).

Vite is the fifth resolver and needs nothing: it reads the workspace symlink and the package's
own `exports` map.

**A subpath export** — `@vn/scriptedit/write` is the only one — costs two more entries, because a
subpath names its source file rather than `index.ts`: a `paths` line of its own in the root
`tsconfig`, and the `'^@vn/([^/]+)/([^/]+)$'` rule in jest's `moduleNameMapper`. `scripts/aliases.mjs`
carries them in a `SUBPATHS` list beside `PACKAGES`. Split a package this way when **one half must
stay out of the renderer's bundle**: the renderer imports `apps/desktop/src/shared/`, so anything
reachable from there reaches the browser, and neither typecheck pass catches it (a type-only use of
a node-side type erases cleanly — only `vite build` fails, with
`"…" is not exported by "__vite-browser-external"`).

## Lint

- **The boundaries rule needs the TypeScript import resolver.** `eslint.config.mjs` sets
  `'import/resolver': { typescript: … }`. With the legacy node resolver it resolved nothing
  (source-only packages have an `exports` map and no `main`), and an _unresolved_ import is an
  unclassified one — which `boundaries/element-types` silently passes. The package layering
  was advertised but not actually enforced until that was fixed.

## Test

- **jest config is `jest.config.cjs`** (the plan said `.ts`) to avoid bootstrapping ts-node
  just to read config. One display-named project per package.
- **Tests live in a `tests/` subfolder beside the code they cover**
  (`packages/model/src/tests/model.test.ts`, `packages/debug2d/src/dom/tests/stacking.test.ts`);
  every project's `testMatch` is `**/<scope>/**/tests/*.test.ts`, so a `*.test.ts` outside a
  `tests/` dir is silently never run.
- The desktop project is `**/apps/desktop/**/tests/*.test.ts` — `.ts` only, node environment,
  no jsdom. See [`../reference/desktop-app.md`](../reference/desktop-app.md) for what that implies about where renderer
  logic lives.

## Continuous integration

Three workflows, and how each one is allowed to fail is the point: a job blocks only where its
verdict is unambiguous.

- **`ci.yml` runs on every push and pull request.** Its `check` job is `pnpm check`, `pnpm test`
  and `pnpm lint` as three separate steps, so a failure names the gate without anyone opening the
  log. It checks out `submodules: recursive`, because `pnpm check:renderer` typechecks against
  path.ux's source.
- **A second `links` job runs `pnpm check:keylinks`** — every URL in `docs/api-keys.md`'s vendor
  blocks, requested. Blocking, because a dead link in the instructions a brand-new user follows is
  a shipped bug, and the verdict is a status code rather than an opinion. Separate from `check`
  because it is the one gate that can go red on somebody else's outage, so it should read as its
  own tick rather than as "the tests broke"; and because nothing it touches is compiled through
  the renderer, it takes no submodules and so runs whatever state `vendor/path.ux` is in.
- **`release.yml` runs on a `v*` tag**, and is four jobs: a `version` job that asserts the tag
  against `apps/desktop/package.json` and never writes it, the same green `gate` as `ci.yml` run
  once rather than once per matrix leg, a Windows `build` matrix that packages and uploads, and a
  `publish` job that makes a **draft** release. Publishing is what makes every installed copy's
  update check start offering the build, so it is the irreversible act and stays a person's.
  Details, and why `publish` refuses an already-published tag:
  [`../plans/archive/release-ci-workflow.md`](../plans/archive/release-ci-workflow.md).
- **`key-docs-audit.yml` runs weekly** — `pnpm audit:keydocs`, which asks a model whether the
  _words_ around those links are still true. Advisory: it exits 0 in every path there is, and
  turns drift into one issue rather than a red tick. A model comparing prose to prose will be
  wrong some of the time, and a blocking check that is wrong some of the time is one people learn
  to override. Neither tier ever writes to `docs/api-keys.md`.
- **Two verdicts are deliberately not failures.** Tier 1 reports `unverified` when a host answers
  a sibling path that cannot exist — `aistudio.google.com` serves its sign-in for every URL under
  it, so a 200 there proves only that the host is up. Tier 2 reports `could-not-check` for the
  same reason from the other end. Whether a vendor hides its console behind a login is not a fact
  about our file. Both counts are printed every run, because the number going up is the signal
  that the check is quietly ceasing to be one.
- Why the two key-doc tiers are shaped this way, in full:
  [`../plans/archive/auditing-the-api-key-instructions.md`](../plans/archive/auditing-the-api-key-instructions.md).

## Format and package manager

- **Formatting uses standard `prettier`** (the plan mentioned a `@pathtx/prettier` fork, which
  is not available here). `docs/**` and `Readme.MD` are in `.prettierignore`.
- pnpm needs `"pnpm": { "onlyBuiltDependencies": ["esbuild", "electron"] }` so those two
  packages' postinstall scripts run — esbuild fetches its platform binary, electron its runtime.
