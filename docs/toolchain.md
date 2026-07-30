# Toolchain

How this monorepo is built, checked, tested and formatted — and where each choice
deliberately deviates from [`plans/initial-implementation.md`](plans/initial-implementation.md).
The day-to-day command table lives in [`../CLAUDE.md`](../CLAUDE.md); this is the "why it is
wired that way" companion.

<!-- toc -->

- [Typecheck](#typecheck)
- [Bundling](#bundling)
- [Adding a package](#adding-a-package)
- [Lint](#lint)
- [Test](#test)
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
  `apps/desktop/dist/commands.json` (see [`command-system.md`](command-system.md)). Both
  bundle scripts share one alias map, `scripts/aliases.mjs`, so their package lists can't
  drift.

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
  no jsdom. See [`desktop-app.md`](desktop-app.md) for what that implies about where renderer
  logic lives.

## Format and package manager

- **Formatting uses standard `prettier`** (the plan mentioned a `@pathtx/prettier` fork, which
  is not available here). `docs/**` and `Readme.MD` are in `.prettierignore`.
- pnpm needs `"pnpm": { "onlyBuiltDependencies": ["esbuild", "electron"] }` so those two
  packages' postinstall scripts run — esbuild fetches its platform binary, electron its runtime.
