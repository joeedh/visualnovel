# Toolchain

Describes how this monorepo is built, checked, tested and formatted, and where each choice deliberately deviates from
[`../plans/archive/INDEX.md#initial-implementation`](../plans/archive/INDEX.md#initial-implementation). The day-to-day command
table is in [`../../CLAUDE.md`](../../CLAUDE.md); this document explains why the setup is wired that way.

<!-- toc -->

- [Typecheck](#typecheck)
- [Bundling](#bundling)
- [Vendored libraries](#vendored-libraries)
- [Packaging the desktop app](#packaging-the-desktop-app)
- [Adding a package](#adding-a-package)
- [Lint](#lint)
- [Test](#test)
- [Continuous integration](#continuous-integration)
- [Format and package manager](#format-and-package-manager)

<!-- tocstop -->

## Typecheck

- **Flat, not project-references.** `pnpm check` runs `tsgo --noEmit -p tsconfig.json` over the whole workspace, not `tsgo -b`.
  The root `tsconfig.json` maps every `@vn/*` package to its `src/index.ts` through relative `paths` (TypeScript 7 / `tsgo`
  removed `baseUrl`, so non-relative paths are rejected).
- **A second pass typechecks the renderer.** Root `tsconfig.json` includes only `*/src/**`, and the desktop renderer sits
  outside `src` by design (at `apps/desktop/renderer/**`), so the root check never covers its JSX. `pnpm check` therefore runs
  `tsgo -p tsconfig.json && pnpm check:renderer`, and `pnpm check:renderer` runs `tsgo --noEmit -p renderer/tsconfig.json` in
  `apps/desktop`. Without that second pass nothing typechecks the renderer, because `vite build` uses esbuild, which does not
  typecheck. `renderer/tsconfig.json` has its own `paths` map; add `@vn/*` entries there as needed, using relative form only. The
  `types` field in `renderer/tsconfig.json` carries `node` and `jest`, so the renderer's `tests/` siblings are typechecked by the
  renderer pass rather than by the root check.
- `tsgo` comes from `@typescript/native-preview` (TS7 dev). `"jest"` is in `compilerOptions.types`, so test globals typecheck.

## Bundling

- **`esbuild` transpiles and `tsgo` verifies.** esbuild never type-checks. It bundles the three apps (`scripts/esbuild.cli.mjs`,
  `scripts/esbuild.authoring.mjs`, `scripts/esbuild.desktop.mjs` — the last for the Electron main process and preload only; the
  renderer goes through vite), bundles the command catalog entrypoint (`scripts/gen-command-catalog.mjs`), and serves as the jest
  transform (`scripts/jest-esbuild.cjs`). Internal packages ship source only: there is no per-package `dist`, and consumers import
  `src/index.ts` directly.
- **Relative imports carry an explicit `.js` extension.** The repo is ESM with `verbatimModuleSyntax`, so a relative import of
  `foo.ts` is written as `./foo.js` — esbuild and `tsgo` both resolve it, and jest's `moduleNameMapper` strips it back off. A bare
  `./foo` typechecks under the bundler resolver and then fails at runtime in the built app.
- **`turbo` orchestrates the bundles.** Each app owns a `build` script (`apps/cli`, `apps/authoring`, `apps/desktop`); `pnpm
  build` runs `turbo run build` across all three, and `build:cli` / `build:authoring` / `build:desktop` are thin `--filter=…`
  wrappers for one app at a time. Because internal packages are source-only (no build task of their own), their sources can't be
  picked up via `dependsOn: ["^build"]` — so `turbo.json` lists `packages/*/src/**`, the esbuild scripts, and the tsconfigs as
  `globalDependencies`, and those globs invalidate an app's cache. Outputs are `dist/**`; the local cache lives in `.turbo`
  (gitignored).
- **The vendored submodules belong in `globalDependencies` as well.** The renderer compiles path.ux and nstructjs from the
  submodule via vite aliases rather than from a package, so no file in `apps/desktop` changes when a submodule changes. Without
  `vendor/path.ux/scripts/**` and `vendor/nstructjs/build/**` on the list, `pnpm build` replays a cached `dist/**` over a freshly
  built `dist/**` and the app runs the previous path.ux. The glob stops at `scripts/` and `build/` because each submodule carries
  a `node_modules` that would otherwise be hashed.
- **The desktop bundle has a third step, `build:catalog`.** `scripts/gen-command-catalog.mjs` bundles
  `apps/desktop/src/main/commands/catalog-entry.ts` and writes `apps/desktop/dist/commands.json` (see
  [`../reference/command-system.md`](../reference/command-system.md)). Both bundle scripts share one alias map,
  `scripts/aliases.mjs`, so their package lists cannot drift.

## Vendored libraries

Three alias names reach the two vendored submodules. `pathux` is the whole library and only the renderer imports it.
`@vn/gengraph` imports path.ux's node-graph module through `pathux-graph`, and imports through `pathux-toolprop` the
`ToolProperty` classes a node spec declares its props with. The graph module does not re-export the property classes, which is why
`pathux-toolprop` exists. `nstructjs` is the serializer both path.ux and this repo use.

- **path.ux needs its own install, separately from the root's.** It has its own `package.json` and lockfile and is not a pnpm
  workspace member, so `pnpm install` at the root skips it; `git submodule update --init --recursive` only checks out the source
  and never runs an install. `pnpm check:setup` (`scripts/check-submodules.mjs`) fails by name when either step has not been run.
  On a clean checkout that skipped the second install, the symptom is scores of "has no exported member" errors inside `vendor/`,
  each naming a symbol rather than the missing install. A contributor who has built path.ux before already has its `node_modules`
  on disk, so the failure is easy to miss.
- **An alias resolves to source where code runs and to declarations where code is only checked.** The run surfaces are
  `scripts/aliases.mjs` (read by `esbuild.desktop.mjs`, `esbuild.cli.mjs`, `esbuild.authoring.mjs` and `gen-command-catalog.mjs`),
  jest's shared `moduleNameMapper`, and `apps/desktop/vite.config.ts`; all three name a `.ts` file under `vendor/`. The check
  surfaces are the root `tsconfig.json` and `apps/desktop/renderer/tsconfig.json`, which name `.d.ts` files under
  `apps/desktop/dist/pathux-types/`. The check surfaces name declarations rather than source because path.ux's import chain
  reaches DOM types that the root program's `lib` does not carry.
- **`pnpm check` builds the declarations before it reads them.** The root `check` script runs `pnpm --filter @vn/desktop
  build:pathux-types` first, which is `tsgo -p apps/desktop/pathux-types.tsconfig.json`. Reordering those two steps makes `check`
  pass even though `pathux-graph` resolves to nothing on a clean checkout.
- **Every checker that sees two of these names resolves them through the same declaration output.** path.ux classes carry
  private members, so a `Graph` typed from source and a `Graph` typed from declarations are nominally incompatible duplicates
  rather than the same class. `nstructjs` is pinned to `vendor/nstructjs` everywhere for the same reason: two copies in one
  process create two STRUCT registries, and a class registered in one is unreadable by the other.
- **eslint classifies the declaration tree as its own element.** `boundaries/elements` in
  `eslint.config.mjs` carries a `pathux` entry for `apps/desktop/dist/pathux-types`, listed
  before the `desktop` entry so it matches first. Without it the TypeScript resolver reports
  an import of the vendored library as an import of the desktop app, and the layering rule
  refuses it.

## Packaging the desktop app

`pnpm package` (unpacked-only: `pnpm package:dir`) turns `apps/desktop` into an installer. electron-builder does the work,
configured in `apps/desktop/electron-builder.yml` — which carries the comments explaining each choice, so read that file rather
than this section for the reasoning behind each one. The plan is in
[`../plans/archive/INDEX.md#packaging-the-desktop-app`](../plans/archive/INDEX.md#packaging-the-desktop-app). This section lists
four things about how it fits the rest of the toolchain:

- **Packaging runs from a scratch project, not from the workspace.** pnpm's `node_modules` holds symlinks into a
  content-addressed store, and electron-builder does not reproduce that layout in an app image. So `scripts/package.desktop.mjs`
  assembles `apps/desktop/.package/`, which holds a `package.json` naming only the two runtime dependencies and `dist/` beside it,
  then runs `pnpm install --ignore-workspace --config.node-linker=hoisted` there. The workspace's own `node_modules` is untouched.
  Both `.package/` and `release/` are gitignored.
- **Only two packages ship.** Everything under `packages/` plus `nstructjs` and the whole of path.ux is bundled into `dist/` by
  esbuild and vite; `scripts/aliases.mjs` leaves exactly `electron`, `@google/genai` and `@anthropic-ai/sdk` external. This
  bundling is why the `files` list is written out rather than left to a default glob, and why it excludes `dist/pathux-types/`, a
  `tsgo` artifact that lands in the same `dist/` as the runtime files.
- **`pnpm smoke` runs the packaged executable.** Both SDKs are loaded through a lazy `import()` when a model is first called, so
  a packaging mistake that drops them produces an app that installs, opens, and opens a project, then throws `Cannot find module`
  at the first agent turn. Any check that only waits for a window passes such a build. `scripts/smoke.desktop.mjs` launches the
  built binary with `--smoke`, which forces one import of each and exits; `src/main/smoke.ts` holds the logic and its tests. It
  runs with the vendor key variables blanked, so the result never depends on the developer's key. The same run checks the shipped
  source, which fails just as silently: the app stays usable and only the debug agent's source box fails. It checks every root of
  `READABLE` rather than only that `sourceRoot()` returned a path, because `CLAUDE.md` and `packages/` alone satisfy that lookup —
  a snapshot missing `docs/` or `apps/` would resolve, and the analyst would then read a build it cannot see half of. The release
  workflow runs `pnpm smoke` between `pnpm package` and the artifact upload, so none of these reaches a draft release.
- **The installer carries the app's own source at `<resourcesPath>/source`.** The debug agent reads it to explain a bad
  conversation. `scripts/package.desktop.mjs` bundles `packages/agentreport/src/sourcemap.ts` to a throwaway CJS file (the same
  approach `gen-command-catalog.mjs` uses on the command registry) and walks `READABLE` through that module's own `denied` and
  `textFile`, so the files that ship and the files the agent reads come from one list. The copy is roughly 800 files and 8 MB.
  `DENY` has to name every build directory, because an undenied `apps/desktop/.package` would copy the previous run's image into
  the next run's.
- **`apps/desktop/package.json`'s `version` is the app version.** The root and every package stay at `0.0.0`, since they are
  private and unpublished and a version number on them serves no purpose. A release tag is asserted against that field rather than
  written into it, and a build made between releases reports `0.1.0 (dev <sha>)` via `src/main/version.ts`. Cutting a release
  takes two steps in order: bump that field in an ordinary reviewed commit, then tag it `v<version>`. `release.yml`'s `version`
  job fails by name if the two disagree.

Two paths inside a packaged app differ from what a checkout would suggest, and both cost an evening once. `__dirname` resolves
inside `app.asar`, which is a file, so anything derived from it and then written to fails with `ENOTDIR` (the session store lives
under `userConfigDir()` for this reason). `docs/api-keys.md` arrives as `extraResources` under `process.resourcesPath`, which is
what `src/main/resources.ts` looks at first.

## Adding a package

Four separate lists enumerate packages, and a different tool resolves each one. A package can therefore typecheck, pass its tests,
and still fail to bundle:

1. the root `tsconfig.json` `paths` map (what `tsgo` resolves),
2. 2. `PACKAGES` in `jest.config.cjs`, which lists the display-named project (a project with no matching tests fails `pnpm test`,
   so add it in the same commit as the code),
3. 3. `ALLOWED` + `boundaries/elements` in `eslint.config.mjs`, which declare the layer and its allow-list,
4. 4. `PACKAGES` in `scripts/aliases.mjs`, which esbuild resolves against in both bundle scripts.

Vite is the fifth resolver and needs nothing beyond what is already there. It reads the workspace symlink and the package's own
`exports` map.

A subpath export (`@vn/scriptedit/write` and `@vn/gengraph/state` are the two) costs two more entries, because a subpath names its
source file rather than `index.ts`. Those entries are a `paths` line of its own in the root `tsconfig` and the
`'^@vn/([^/]+)/([^/]+)$'` rule in jest's `moduleNameMapper`. `scripts/aliases.mjs` carries them in a `SUBPATHS` list beside
`PACKAGES`. Split a package this way when one half must stay out of the renderer's bundle. The renderer imports
`apps/desktop/src/shared/`, so anything reachable from there reaches the browser, and neither typecheck pass catches it. A
type-only use of a node-side type erases cleanly, so only `vite build` fails, with `"…" is not exported by
"__vite-browser-external"`.

## Lint

- **The boundaries rule needs the TypeScript import resolver.** `eslint.config.mjs` sets `'import/resolver': { typescript: … }`.
  The legacy node resolver resolved nothing, because source-only packages have an `exports` map and no `main`, and
  `boundaries/element-types` passes an unresolved import without classifying it. The package layering was advertised but not
  enforced until that was fixed.

## Test

- **jest config is `jest.config.cjs`** (the plan said `.ts`) to avoid bootstrapping ts-node just to read config. The config
  declares one display-named project per package.
- **Tests live in a `tests/` subfolder beside the code they cover** (`packages/model/src/tests/model.test.ts`,
  `packages/debug2d/src/dom/tests/stacking.test.ts`). Every project's `testMatch` is `**/<scope>/**/tests/*.test.ts`, so a
  `*.test.ts` file outside a `tests/` directory never runs and no failure is reported.
- The desktop project matches `**/apps/desktop/**/tests/*.test.ts`. It picks up `.ts` files only and runs them in a node
  environment without jsdom. See [`../reference/desktop-app.md`](../reference/desktop-app.md) for what that implies about where
  renderer logic lives.

## Continuous integration

Three workflows follow, and they differ in how each one is allowed to fail. A job blocks only where its verdict is unambiguous.

- **`ci.yml` runs on every push and pull request.** Its `check` job runs `pnpm check`, `pnpm test` and `pnpm lint` as three
  separate steps, so the name of the failed step identifies the gate and nobody has to open the log. The job checks out with
  `submodules: recursive`, because `pnpm check:renderer` typechecks against path.ux's source.
- **A second `links` job runs `pnpm check:keylinks`** — the job requests every URL in the vendor blocks of docs/api-keys.md. It
  is blocking, because a dead link in the instructions a brand-new user follows is a shipped bug, and the verdict is a status code
  rather than an opinion. It stays separate from `check` for two reasons. It is the one gate that can go red on somebody else's
  outage, so it should read as its own tick rather than as "the tests broke". Nothing it touches is compiled through the renderer,
  so it takes no submodules and runs against whatever state `vendor/path.ux` is in.
- **`release.yml` runs on a `v*` tag** and has four jobs: a `version` job that asserts the tag against
  `apps/desktop/package.json` and never writes it, the same green `gate` as `ci.yml` run once rather than once per matrix leg, a
  Windows `build` matrix that packages and uploads, and a `publish` job that makes a draft release. Publishing makes every
  installed copy's update check start offering the build, so it is the irreversible act and a person performs it. For details, and
  for why `publish` refuses an already-published tag, see
  [`../plans/archive/INDEX.md#release-ci-workflow`](../plans/archive/INDEX.md#release-ci-workflow).
- **`key-docs-audit.yml` runs weekly** — it runs `pnpm audit:keydocs`, which asks a model whether the prose around those links
  is still true. The check is advisory: it exits 0 on every path, and reports drift as an issue rather than a failing check. A
  model comparing prose to prose will be wrong some of the time, and a blocking check that is wrong some of the time is one people
  learn to override. Neither tier writes to `docs/api-keys.md`.
- **Two verdicts are deliberate and are not failures.** Tier 1 reports `unverified` when a host answers a sibling path that
  cannot exist — `aistudio.google.com` serves its sign-in for every URL under it, so a 200 there proves only that the host is up.
  Tier 2 reports `could-not-check` for the same reason from the other end. Whether a vendor hides its console behind a login is
  not a fact about our file. Both counts are printed every run, so a rising count shows that the check is verifying less and less.
- The full account of why the two key-doc tiers are shaped this way is in
  [`../plans/archive/INDEX.md#auditing-the-api-key-instructions`](../plans/archive/INDEX.md#auditing-the-api-key-instructions).

## Format and package manager

- **Formatting uses standard `prettier`** (the plan mentioned a `@pathtx/prettier` fork, which
  is not available here). `docs/**` and `Readme.MD` are in `.prettierignore`.
- pnpm needs `"pnpm": { "onlyBuiltDependencies": ["esbuild", "electron"] }` so those two packages' postinstall scripts run. The
  esbuild script fetches its platform binary, and the electron script fetches its runtime.
