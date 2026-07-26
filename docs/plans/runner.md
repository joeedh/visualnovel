# Plan: Playable export format + desktop VN runner

## Context

The pipeline deliberately stops at `manifest.json` (a presentation-agnostic IR: story
graph + content-addressed asset store). To actually *watch* a generated VN we need a
runner. Per `docs/visualNovelFormats.md`, the right move for a **simple** runner on the
existing Electron/React stack is **not** to export to an external DSL (Ren'Py/Ink) but to
emit a small in-house **`story.play.json`** — a flattened, ordered play-list that is a thin
projection of the existing `Scene`/`Shot`/`Asset` types — and interpret it in a React view
inside `apps/desktop`.

This plan does **both**: (A) the export format + exporter, and (B) the desktop runner.

Two facts from exploration shape the design:
- **`Shot.coversLines` is vestigial** — nothing assigns stable dialogue-line ids, and
  `Scene.body` is a lossy flattened prose string (structured speaker/dialogue is discarded
  in `splitScenes`). Per the user's decision we will **introduce real line ids first** so
  shots bind to exact lines and the runner can swap art per line.
- **The desktop renderer has no image-loading path today** and `workspace:index` is only a
  flat summary. We add a `vnasset://` protocol for images and a live IPC channel that
  builds the playable in-process.

Decisions locked with the user: **real line ids** (not scene-granular art), **build the
playable live in the main process**, and a **full save/load** runner.

---

## Part A — Structured scene lines + real line ids

Goal: every dialogue/action/parenthetical beat gets a stable, scene-scoped id, and shots
reference real ids.

1. **`packages/types/src/entities.ts`** — add a `SceneLine` and hang it on `Scene`:
   ```ts
   export interface SceneLine {
     id: string;                 // stable, scene-scoped, e.g. `${sceneId}:L3`
     kind: 'dialogue' | 'action' | 'parenthetical' | 'narration';
     speaker?: string;           // characterId, present for dialogue/parenthetical
     text: string;
   }
   // on Scene:
   lines: SceneLine[];           // ordered; derived from the Fountain source
   ```
   `body` stays for back-compat/serialization; `lines` is the structured source of truth.

2. **`packages/model/src/scenes.ts`** (`splitScenes`) — while walking `FountainScript.elements`,
   build `lines[]` in parallel with the existing `bodyLines[]`. Preserve element `type`
   (currently collapsed): `character` sets the current speaker; `dialogue`/`parenthetical`
   attach to it; `action` with no active speaker → `narration`. Assign ids as
   `` `${scene.id}:L${n}` `` with a per-scene counter. Map cue names → character ids using
   the same resolution `Scene.characters` already uses. `lines` is **derived at model
   build** (regenerated from the screenplay each run) — no new round-trip persistence
   burden; `serialize.ts` may omit it.

3. **`packages/pipeline/src/p5.ts`** — make shot decomposition produce real `coversLines`:
   - `deterministicShots`: establishing shot covers the scene's `narration`/`action` line
     ids; each per-character medium shot covers that character's `dialogue` line ids.
   - `decomposeScene` (LLM path): **validate** returned `coversLines` against the scene's
     real line-id set (drop unknown ids) before accepting, so LLM output can't invent ids.

4. Tests: extend `packages/model` scene tests to assert ordered `lines` + stable ids and
   speaker attribution; extend `packages/pipeline` p5 tests to assert `coversLines` are
   real ids.

---

## Part B — `@vn/export` package + `story.play.json`

New leaf package downstream of the manifest. Depends only on `types, util, parse, model,
store`; **must not** import `pipeline`/`scheduler` (add a `boundaries` element entry so lint
enforces it, mirroring how `@vn/authoring` is constrained).

1. **Playable schema** — `packages/types/src/playable.ts` (zod + inferred TS), re-exported
   from `@vn/types` index. Shape:
   ```jsonc
   {
     "version": 1,
     "title": "…",
     "start": "scene-1",
     "characters": { "aiko": { "name": "Aiko", "portrait": {"hash":"…","ext":"png"} } },
     "scenes": {
       "scene-1": {
         "beats": [
           { "type": "show",    "image": {"hash":"…","ext":"png"} },   // background/shot
           { "type": "say",     "who": "aiko", "text": "You're late." },
           { "type": "narrate", "text": "The bell had already rung." }
         ],
         "choices": [ { "label": "Apologize", "goto": "scene-2a" } ],
         "next": "scene-3"     // followed when choices is empty
       }
     }
   }
   ```
   Asset refs are `{hash, ext}` (matches `AssetRef`) — resolved by the runner via
   `vnasset://`, never inlined.

2. **Exporter** — `packages/export/src/playable.ts`:
   `buildPlayable(model: ProjectModel, store: AssetStore): Playable` (pure, in-memory).
   - Iterate `scene.lines` in order. Track the shot covering the current line
     (`shot.coversLines.includes(line.id)`); when it changes, emit a `show` beat with that
     shot's image. Then emit `say` (dialogue/parenthetical, with `who`) or `narrate`
     (narration/action).
   - Resolve images from `store.manifest()` (no query index exists — filter manually):
     shot image = `a.kind==='shot_image' && a.satisfies.shotId===shot.id && a.accepted`;
     portrait = `character.approvedPortrait` (fall back to `kind==='portrait' &&
     satisfies.characterId===id && accepted`). Missing assets → omit the ref (runner shows
     a placeholder), never throw, so partially-generated projects still play.
   - `choices` from `scene.choices` (`{label, goto}`); `next` from `scene.next`;
     `start` from the model entry scene.
   - A thin `writePlayable(paths, playable)` helper writes
     `vngen/build/story.play.json` (atomic write via `@vn/util`).
3. Package scaffolding: `package.json` (source-only, `workspace:*` deps), `src/index.ts`,
   `tsconfig` path entry in root `tsconfig.json`, jest project in `jest.config.cjs`, and
   the `eslint-plugin-boundaries` element. Follow an existing leaf package (e.g.
   `@vn/store`) as the template.
4. Tests: `buildPlayable` over `examples/sample` (mock/derived model) → assert beat order,
   speaker attribution, choice/next wiring, and graceful handling of missing assets.

---

## Part C — `vngen export` CLI command

- **`apps/cli/src/commands.ts`** — add `export [dir]`: load config → `ProjectPaths` →
  `loadInputs` → `parseFountain` → `buildModel` → `AssetStore.open` → `buildPlayable` →
  `writePlayable`. Mirror the wiring already in the `status`/`graph` commands. Register in
  the CLI dispatcher and `--help`; add a `commands.test.ts` case.
- Update the CLI usage block in `CLAUDE.md` and the `## CLI` section.

---

## Part D — Desktop runner (`apps/desktop`)

1. **Asset delivery — `vnasset://` protocol.** In `apps/desktop/src/main/index.ts`,
   register a custom protocol on app-ready that streams
   `paths.assetFile(hash, ext)` for `vnasset://<hash>.<ext>` (use
   `protocol.handle`/`registerFileProtocol` off the session's `ProjectPaths`). Add the
   scheme to `webSecurity`/CSP as needed so `<img src="vnasset://…">` loads in the
   renderer. This is the missing image path the whole app lacks today.

2. **Live playable over IPC.** In `apps/desktop/src/shared/ipc.ts` add invoke channel
   `story:play` → `Playable`. Back it in `src/main/session.ts` (`WorkspaceSession`) by
   calling `buildPlayable(this.model, this.store)` on the already-loaded model+store — no
   file needed to preview. Expose through preload automatically (generic `invoke`).

3. **Runner view.** Add a third room to the manual navigation:
   - `apps/desktop/renderer/App.tsx`: extend `Room` with `'play'`, add a `PLAY` `Topbar`
     button, render `<Runner/>` in the conditional (mirror the `Floor` component pattern —
     self-contained, fetches via `api.invoke('story:play')`).
   - New `apps/desktop/renderer/Runner.tsx`: state = `{sceneId, beatIndex, history[]}`.
     Render background (`show` image via `vnasset://`), the active speaker's portrait
     (last `say.who`), and a dialogue box (speaker name + text). Click/Space advances
     `beatIndex`; at end of `beats` render choice buttons (`goto`) or auto-follow `next`;
     leaf scene → "The End". `history[]` drives a **Back** control (rewind beat/scene).
   - Styling in `apps/desktop/renderer/styles.css` reusing existing design tokens
     (`--ink`, `--signal`, …); no new CSS framework.

4. **Full save/load.** Persist playthrough state (`{sceneId, beatIndex, history}`) to
   `localStorage`, keyed by workspace title, with Save / Load / Reset controls in the
   Runner. localStorage keeps it self-contained in the renderer (no extra IPC/file writes);
   if cross-machine saves are ever wanted, promote to a `runner:save`/`runner:load` channel
   writing under `vngen/state/saves/`.

---

## Files touched (representative)

- `packages/types/src/entities.ts` (SceneLine, Scene.lines), `packages/types/src/playable.ts` (new), `packages/types/src/index.ts`
- `packages/model/src/scenes.ts` (build `lines[]`), model tests
- `packages/pipeline/src/p5.ts` (real `coversLines` + validation), p5 tests
- `packages/export/**` (new package: `package.json`, `src/index.ts`, `src/playable.ts`, tests)
- root `tsconfig.json`, `jest.config.cjs`, `.eslintrc`/boundaries config (register new package)
- `apps/cli/src/commands.ts` + `commands.test.ts` (`export` command)
- `apps/desktop/src/main/index.ts` (`vnasset://`), `src/shared/ipc.ts` (+`story:play`), `src/main/session.ts` (buildPlayable)
- `apps/desktop/renderer/App.tsx`, `renderer/Runner.tsx` (new), `renderer/styles.css`
- `CLAUDE.md` (CLI docs + package table row for `@vn/export`)

## Verification

1. **Gates:** `pnpm check`, `pnpm test`, `pnpm lint` all green before and after.
2. **Line ids / exporter (offline):** `pnpm build` then
   `node apps/cli/dist/cli.js export examples/sample` → inspect
   `examples/sample/vngen/build/story.play.json`: beats in reading order, `say` beats carry
   the right `who`, `show` beats appear where shots change, `choices`/`next`/`start` match
   the story graph. Since `examples/sample` may lack real generated assets, confirm image
   refs are present where assets exist and cleanly omitted where they don't.
3. **Runner (via `/run` skill / electron):** launch the desktop app (it opens
   `examples/mySampleRepo`, seeded from `examples/sample` on first launch),
   switch to the **PLAY** room, and confirm: dialogue advances on click, speaker portraits
   render through `vnasset://` (or placeholder when absent), background swaps per shot,
   choices route to the correct next scene, Back rewinds, and Save→Reset→Load restores
   position. Drive it with the `run` skill to observe real behavior, not just tests.
4. **Boundaries:** confirm the lint rule rejects an `import '@vn/pipeline'` added to
   `@vn/export` (quick negative check).
