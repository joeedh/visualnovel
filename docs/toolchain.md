# Toolchain

How this monorepo is built, checked, tested and formatted — and where each choice
deliberately deviates from [`plans/initial-implementation.md`](plans/initial-implementation.md).
The day-to-day command table lives in [`../CLAUDE.md`](../CLAUDE.md); this is the "why it is
wired that way" companion.

<!-- toc -->

- [Typecheck](#typecheck)
- [Bundling](#bundling)
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

- **`esbuild` transpiles; `tsgo` verifies.** esbuild never type-checks. It is used in exactly
  two places: bundling the CLI (`scripts/esbuild.cli.mjs`) and as the jest transform
  (`scripts/jest-esbuild.cjs`). Internal packages are **source-only** — no per-package
  `dist`; consumers import `src/index.ts` directly.
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
- pnpm needs `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` so esbuild's postinstall runs.
