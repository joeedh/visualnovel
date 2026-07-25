# Plan: desktop renderer restructure

**Status:** not started.
**Gates:** every editor plan in [`desktop-editors-tracking.md`](desktop-editors-tracking.md).
Nothing else should start until this lands.

## Why

The renderer is about to roughly triple in size (four editor surfaces, two of them
canvas-based). Three properties of the current layout make that unsafe:

1. **Nothing typechecks the renderer.** The root `pnpm check` runs
   `tsgo --noEmit -p tsconfig.json`, whose `include` is
   `["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"]`. The renderer lives at
   `apps/desktop/renderer/**` — deliberately outside `src` so the root check never sees its
   JSX — and has its own `renderer/tsconfig.json` that **no script ever invokes**.
   `vite build` uses esbuild, which never type-checks. So renderer type errors are invisible
   until runtime, today, right now.
2. **`App.tsx` is a shell plus three components** (446 lines: `App`, `Topbar`, `Studio`,
   `PlanCard`). Room switching, agent feed state, plan approval, palette state, and the
   STUDIO layout are one file.
3. **`styles.css` is a single 1217-line sheet.** Four editors would take it past 3000 lines
   with no ownership boundaries.

This plan is a **pure refactor plus one new check**. No behavior changes, no new features.

## Wave 1 — close the typecheck gap

Do this first and alone; it is the safety net for every wave after it.

- Add to `apps/desktop/package.json`: `"check": "tsgo --noEmit -p renderer/tsconfig.json"`.
- Add to the root `package.json`: `"check:renderer": "pnpm --filter @vn/desktop check"`, and
  change `"check"` to run both — `"tsgo --noEmit -p tsconfig.json && pnpm check:renderer"`.
- Fix whatever errors surface. **Expect some**; this code has never been checked. Budget for
  it rather than assuming a clean first run.
- `renderer/tsconfig.json` maps only `@vn/authoring`, `@vn/debug2d`, `@vn/types`. Add
  entries as later waves need them, keeping the relative-path form (`tsgo` rejects
  `baseUrl`).

**Done when:** `pnpm check` fails on a deliberately introduced renderer type error, and
passes on `master`.

## Wave 2 — split the shell out of `App.tsx`

```
renderer/app/
  App.tsx        shell only: room state, palette state, effect subscriptions
  Topbar.tsx     the room nav + badges
  useAgent.ts    feed, dboxLine, plan requests, send/toggleMode/clear
```

`useAgent` collects the `agent:event` / `permission:plan` subscriptions and the
`feed`/`dboxLine`/`planReq`/`busy` state that STUDIO consumes. `App.tsx` keeps only what the
shell owns: `room`, `paletteOpen`, and the `command:ui` effect subscription (`App.tsx:85`) —
that one stays in the shell because `view.*` commands target the shell.

## Wave 3 — one directory per room

```
renderer/rooms/
  studio/  Studio.tsx  Rail.tsx  Convo.tsx  PlanCard.tsx
  floor/   Floor.tsx   TaskBoard.tsx  Inspector.tsx  GateOverlay.tsx
  play/    Runner.tsx
```

Straight moves. `Rail.tsx` takes the CAST/SETS/SCENES groups and the `seed()` helper;
`Convo.tsx` takes the transcript + dbox + composer. `Floor.tsx` splits along its existing
internal seams (the file already has `Inspector` and `GateOverlay` as separate components).

**Reserved, not created here:** `renderer/graph/` for shared node-canvas primitives
(viewport transform, hit-testing, layout). The [story branch editor](story-branch-editor.md)
plan populates it; the [task DAG view](task-dag-view.md) plan reuses it. Creating it empty
now would be speculative.

## Wave 4 — split the stylesheet

```
renderer/styles/
  index.css      @imports the rest, in cascade order
  tokens.css     :root custom properties + resets + focus + reduced-motion
  shell.css      .app, .topbar, .rooms, badges
  studio.css     .studio, .rail, .convo, .plan
  floor.css      .floor, .tasks, .inspector, .overlay
  play.css       the runner
```

`main.tsx` changes `import './styles.css'` → `import './styles/index.css'`. Vite resolves
`@import` at build time, so this stays one emitted stylesheet.

**`tokens.css` is the contract every editor plan builds against.** It is worth stating the
existing system explicitly, because the editors inherit it rather than inventing:

| Token | Meaning |
| --- | --- |
| `--sodium` `#f4a24c` | warm — the **authored / human** side (scenes, choices, characters) |
| `--signal` `#45c8d6` | cool — the **machine / pipeline** side (tasks, hashes, assets) |
| `--ink*` | surface ramp, sunken → raised |
| `--disp` Archivo Expanded | display |
| `--prose` Newsreader | authored prose — dialogue, choice labels |
| `--mono` IBM Plex Mono | machine data — hashes, ids, counts |

The sodium/signal split is the single most useful thing the editors inherit: it already
encodes "who made this," so a mixed view (a scene card showing its generated thumbnail) can
say so without a legend. **Do not add new accent hues in the editor plans** — spend the
existing two.

## Wave 5 — renderer test convention

Jest's desktop project is `testMatch: ['**/apps/desktop/**/tests/*.test.ts']` — note `.ts`,
not `.tsx`, and a node environment with no jsdom.

That is a constraint worth designing to rather than working around, and it happens to match
what the coming editors need: **pure geometry, layout, and graph logic goes in `.ts` modules
with a `tests/` sibling; `.tsx` stays thin rendering.** Same shape as `@vn/debug2d`'s
impure-shell / pure-core split, and the same reason — layout math is exactly what you want
under test, and exactly what jsdom cannot help with.

Add `renderer/graph/tests/` and `renderer/rooms/*/tests/` as the homes for that as each
plan needs them. No jsdom, no React Testing Library, no component tests.

## Verification

Per wave, in order:

```sh
pnpm check          # now includes the renderer
pnpm lint
pnpm test
pnpm --filter @vn/desktop build
pnpm --filter @vn/desktop dev     # eyeball all three rooms
```

Then, with the app running, confirm the command surface is intact end to end — it routes
through the registry, so it is the cheapest proof the shell still works:

```sh
node scripts/vn-cdp.mjs "view.room(name='floor')"
node scripts/vn-cdp.mjs "view.room(name='play')"
node scripts/vn-cdp.mjs --catalog
```

## Risks

- **Wave 1 surfaces a pile of errors.** Most likely, since the code has never been checked.
  If it is large, land Wave 1 as its own commit with the fixes, and do not mix moves into it
   — a rename plus a type fix in one diff is unreviewable.
- **CSS cascade order.** Splitting a single sheet can change specificity outcomes if
  `@import` order differs from the original top-to-bottom order. Preserve the original order
  exactly; do not reorganize rules while moving them.
- **`prototype.html`** (56 KB, at `apps/desktop/prototype.html`) is the original design
  reference and shares class names with `styles.css`. It is not built or imported — leave it
  alone, but do not treat it as the source of truth for tokens; `tokens.css` is.

## Out of scope

Component library, CSS modules or CSS-in-JS, state management library, renderer-side
routing, jsdom test setup, and touching `src/main/**` (which is already well-factored — 12
files, none over 60 lines, plus `session.ts`).

## Done

- [ ] `pnpm check` covers the renderer and is green
- [ ] `App.tsx` under 120 lines; no room component defined in it
- [ ] One directory per room; no `.tsx` at `renderer/` root except `main.tsx`
- [ ] `styles/` split, cascade order preserved, app visually identical
- [ ] `CLAUDE.md` toolchain notes updated: the renderer typecheck exists and `pnpm check`
      runs it
