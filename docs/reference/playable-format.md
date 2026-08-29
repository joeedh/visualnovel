# The playable (`story.play.json`)

The pipeline is presentation-agnostic — it stops at `manifest.json`. To actually _watch_ a
generated VN, `@vn/export` projects the model + manifest into a small in-house **playable**,
and the desktop app plays it. This is deliberately **not** an external DSL export (Ren'Py,
Ink, …); it is a thin, ordered view over the existing `Scene`/`Shot`/`Asset` types. Plan:
[`../plans/archive/INDEX.md#runner`](../plans/archive/INDEX.md#runner); the app that renders it is
[`desktop-app.md`](desktop-app.md).

<!-- toc -->

- [Shape](#shape)
- [Contracts](#contracts)
- [The web export](#the-web-export)

<!-- tocstop -->

## Shape

`vngen export [dir]` writes `vngen/build/story.play.json` via
`buildPlayable(model, store, opts?)` (pure, in `@vn/export`; `opts` carries the persisted
`shots` and `portraitOverlay`, both covered under Contracts). Each scene flattens into ordered
**beats** plus its branch edges:

```jsonc
{
  "version": 1,
  "title": "…",
  "start": "arrival", // entry scene id
  "portraitOverlay": false, // project.yaml's portrait_overlay; always written
  "characters": { "aiko": { "name": "Aiko", "portrait": { "hash": "…", "ext": "png" } } },
  "scenes": {
    "arrival": {
      "beats": [
        { "type": "show", "shot": "arrival__establishing", "image": { "hash": "…", "ext": "png" } }, // bg/shot (image omitted if none)
        { "type": "say", "who": "aiko", "text": "Um… hello." }, // attributed dialogue/parenthetical
        { "type": "narrate", "text": "She bows, a little too deeply." }, // narration/action
      ],
      "choices": [{ "label": "Introduce yourself", "goto": "greet" }],
      "next": "rooftop", // followed when choices is empty
    },
  },
}
```

## Contracts

- **Real line ids drive per-line art.** Scenes carry structured `lines` (`SceneLine`, derived
  from the screenplay at model build with stable `${sceneId}:L<n>` ids); `Shot.coversLines`
  binds shots to exact lines. The exporter walks `scene.lines`, emitting a `show` beat whenever
  the covering shot changes, then a `say`/`narrate`. A model rebuilt from disk carries no
  shots, so callers pass `loadSceneShots(paths, model)` — the persisted decompositions — into
  `buildPlayable`; only with no file at all does it reconstruct the deterministic shot
  grouping. Reconstructing over an LLM decomposition names shot ids no run produced, and every
  `show` then comes out image-less.
- **A `show` beat names its shot, so a runner can say where it is.** `shot` is the shot's id,
  written whether or not the frame has an image — a runner that knows the shot can publish the
  playthrough position into a shell's selection, which is what turns watching into a place to
  jump from. It is optional in the schema because a playable written before this existed still
  reads; it is written by every export since.
- **A `transition` line is coverable but produces no beat.** `CUT TO:` is an instruction to the
  reader of a screenplay, not a line of the story — so a shot may cover it, and covering it
  still changes the frame above (the `show` beat is emitted), but the transition itself is not
  said or narrated. It is the one `SceneLine.kind` with no beat of its own.
- **The shot is the whole picture, so a portrait overlay is opt-in.** `buildShotPrompt` names
  the shot's subjects, so a frame with a cast already _is_ a picture of that cast — staging a
  portrait over it draws the same character twice. `portraitOverlay` mirrors `project.yaml`'s
  `portrait_overlay` (default `false`) and is written even when off, because unlike an absent
  asset ref it is a knob and not a not-yet. The character's `portrait` ref is exported either
  way: the flag is presentation, so turning it on is never a re-export. **If you do turn it
  on**, be warned the P3 portrait is prompted for a "plain neutral background"
  (`packages/pipeline/src/prompts.ts`) — an opaque plate, not a keyed cutout, so it lands as a
  rectangle. A real sprite asset with an alpha channel is unbuilt work
  ([`../plans/archive/INDEX.md#portrait-overlay-opt-in`](../plans/archive/INDEX.md#portrait-overlay-opt-in)).
- **Asset refs are `{hash, ext}`**, resolved by the runner (never inlined). A missing asset is
  **omitted, not an error** — a partially- or un-generated project still plays (placeholder
  background/portrait).
- **`@vn/export` is a boundaries-constrained leaf**: like `@vn/authoring` it must not import
  `@vn/pipeline`/`@vn/scheduler`.
- **The first shot covering a line wins**, which is why the coverage timeline refuses double
  coverage rather than silently hiding the second shot's frame — see
  [`desktop-app-editors-story.md`](desktop-app-editors-story.md#shot-coverage).

## The web export

The same playable renders as a static **light-novel site** — one HTML page per scene, with
`choices` and `next` as ordinary links. The app can install a GitHub Actions workflow that
publishes it to GitHub Pages, so a generated VN is readable in a browser without the desktop
runner.

`renderSite(playable)` (`packages/export/src/site.ts`) is pure: it returns the pages to write and
the assets to copy, and touches no filesystem. It reads only the playable, never `Scene`/`Shot` —
the coverage rules were already applied at export. `say` beats render mechanically as speaker plus
line; there is no prose rewriting and no model call anywhere in the path.

Three contracts are worth stating:

- **`site.ts` is not re-exported from the package barrel.** Its only consumer is `site-cli.ts`,
  and re-exporting it would pull an HTML template and a stylesheet into the desktop main bundle.
- **`site-cli.ts` validates by hand rather than through `playableSchema`.** This is the one place
  the repo's "validate at the boundary with zod" rule is deliberately not followed. The module is
  bundled into a file committed to an author's git repository, and zod takes that file from 275
  lines to 4,688. `asPlayable` checks the fields the renderer reads and names the one that is
  wrong. The input is a file the same toolchain wrote one step earlier.
- **The renderer travels with the project.** Every package here is `private: true`, so a CI runner
  cannot `npx vngen`. `scripts/esbuild.sitebuilder.mjs` bundles `site-cli.ts` with no externals
  into `apps/desktop/dist/main/vn-site.mjs`, and `project.installPages` writes that file into the
  project as `.vnstudio/pages/vn-site.mjs`. CI runs it with plain `node` and does no install.

What lands in the author's repository, and what the workflow does with it, is in
[`../guides/github-pages.md`](../guides/github-pages.md).
