# The playable (`story.play.json`)

The pipeline is presentation-agnostic and stops at `manifest.json`. To watch a generated
VN, `@vn/export` projects the model and manifest into a small in-house playable, and the
desktop app plays it. This is deliberately not an external DSL export (Ren'Py, Ink, …). It
is a thin, ordered view over the existing `Scene`/`Shot`/`Asset` types. The plan is
[`../plans/archive/INDEX.md#runner`](../plans/archive/INDEX.md#runner), and the app that
renders it is [`desktop-app.md`](desktop-app.md).

<!-- toc -->

- [Shape](#shape)
- [Contracts](#contracts)
- [The web export](#the-web-export)

<!-- tocstop -->

## Shape

`vngen export [dir]` writes `vngen/build/story.play.json` via
`buildPlayable(model, store, opts?)`, which is pure and lives in `@vn/export`. The `opts`
argument carries the persisted `shots` and `portraitOverlay`, both covered under
Contracts. Each scene flattens into ordered beats plus its branch edges:

```jsonc
{
    "version"        : 1,
    "title"          : "…",
    "start"          : "arrival", // entry scene id
    "portraitOverlay": false, // project.yaml's portrait_overlay; always written
    "characters": {
        "aiko": { "name": "Aiko", "portrait": { "hash": "…", "ext": "png" } },
    },
    "scenes": {
        "arrival": {
            "beats": [
                {
                    "type"  : "show",
                    "shot"  : "arrival__establishing",
                    "image" : { "hash": "…", "ext": "png" },
                    // only on a page shot: each panel's outline in page fractions, and the lines it letters
                    "panels": [
                        {
                            "shape": [
                                [0, 0],
                                [1, 0],
                                [1, 0.5],
                                [0, 0.5],
                            ],
                            "lines"  : ["arrival:L1"],
                            // only under `lettering: runner`, and only for lines with a bubble placed
                            "bubbles": [
                                {
                                    "line"  : "arrival:L1",
                                    "anchor": [0.5, 0.2],
                                    "tail"  : [0.4, 0.4],
                                },
                            ],
                        },
                    ],
                }, // bg/shot (image omitted if none)
                {
                    "type": "say",
                    "who" : "aiko",
                    "text": "Um… hello.",
                    "line": "arrival:L2",
                }, // attributed dialogue/parenthetical
                {
                    "type": "narrate",
                    "text": "She bows, a little too deeply.",
                    "line": "arrival:L3",
                }, // narration/action
            ],
            "choices": [{ "label": "Introduce yourself", "goto": "greet" }],
            "next"   : "rooftop", // followed when choices is empty
        },
    },
}
```

## Contracts

- **Per-line art uses real line ids.** Scenes contain structured `lines` (`SceneLine`,
  derived from the screenplay at model build with stable `${sceneId}:L<n>` ids), and
  `Shot.coversLines` binds shots to exact lines. The exporter walks `scene.lines`,
  emitting a `show` beat whenever the covering shot changes, then a `say`/`narrate`. A
  model rebuilt from disk carries no shots, so callers pass `loadSceneShots(paths, model)`
  (the persisted decompositions) into `buildPlayable`. The exporter reconstructs the
  deterministic shot grouping only when no file exists at all. If it reconstructs over an
  LLM decomposition, the shot ids it produces match no run, and every `show` comes out
  image-less.
- **A `show` beat names its shot, so a runner can report where the playthrough is.**
  `shot` is the shot's id, written whether or not the frame has an image. A runner that
  knows the shot can publish the playthrough position into a shell's selection, which lets
  a viewer jump from the point they are watching. The field is optional in the schema so
  that a playable written before the field existed can still be read, and every export
  since writes it.
- **A page shot is one image, and its `show` beat carries the panels.** A shot with
  `panels` renders as one picture of several panels, and the exporter treats it as any
  other shot: one `show` beat naming the shot, with its single image, when the covering
  shot changes, then the `say`/`narrate` beats of every line it covers over that image.
  The `show` beat additionally lists `panels`, each panel's `shape` (its outline in page
  fractions, clockwise, as authored in `work/shots/<sceneId>.json`) and the `lines` it
  letters (the panel's `coversLines`). A single frame's `show` beat has no `panels` key at
  all, so a playable with no pages is unchanged.
- **Every `say` and `narrate` beat names its line.** `line` is the `SceneLine` id the beat
  was made from, which is how a runner finds the panel that letters it: the desktop
  runner's `framesOf` gives a frame `panel` when the current page has a panel whose
  `lines` include the frame's `line`, and the stage can dim the rest of the page around it
  (off by default; the Play pane's **Dim panels** checkbox turns it on). A line no panel
  letters, and a beat with no `line`, show the page whole. Both fields are optional in the
  schema so a playable written before them still parses. The static site renderer reads
  `line` and `panels[].lines` only to match bubbles, and never reads `shape`
  ([`../plans/manga-style.md#stage-3--panel-stepping-and-the-panel-editor`](../plans/manga-style.md#stage-3--panel-stepping-and-the-panel-editor),
  [`../plans/site-speech-bubbles.md`](../plans/site-speech-bubbles.md)).
- **A panel's `bubbles` say where the runner reads its lines.** Under `lettering: runner`
  the page is drawn wordless and the author places a bubble per line in the Page editor
  (`PagePanel.bubbles`, `story.setBubbles`). The exporter copies each one onto the panel
  as `{ line, anchor, tail? }` in page fractions, and only under `runner`
  (`PlayableOptions.lettering`): under `model` the words are in the picture, and a bubble
  would say each line twice. The desktop runner's `framesOf` gives a frame `bubble` when
  its line has one; the stage then draws the line in a paper bubble at the anchor, with a
  tail to `tail` when there is one and as a caption box when there is not, and leaves out
  the dialogue box for that frame. A line with no bubble is read in the dialogue box with
  its panel lit, as before, so a half-lettered page still reads; nothing places a bubble
  the author did not. The field is optional. The static site renderer draws every bubble
  of the lines read under a `show` over its figure at once, drops those lines from the
  text flow, and never dims the page
  ([`../plans/manga-style.md#stage-5--runner-drawn-bubbles`](../plans/manga-style.md#stage-5--runner-drawn-bubbles),
  [`../plans/site-speech-bubbles.md`](../plans/site-speech-bubbles.md)).
- **A `transition` line is coverable but produces no beat.** `CUT TO:` is an instruction
  to the reader of a screenplay rather than a line of the story. A shot may cover it, and
  covering it still changes the frame above (the `show` beat is emitted), but the
  transition itself is neither said nor narrated. It is the one `SceneLine.kind` that
  produces no beat.
- **A shot already shows its subjects, so the portrait overlay is opt-in.**
  `buildShotPrompt` names the shot's subjects, so a frame with a cast already depicts that
  cast, and staging a portrait over it draws the same character twice. `portraitOverlay`
  mirrors `project.yaml`'s `portrait_overlay` (default `false`) and is written even when
  off, because it is a configuration flag rather than a value still to be filled in,
  unlike an absent asset ref. The character's `portrait` ref is exported either way,
  because the flag affects only presentation, so turning it on never requires a re-export.
  If you do turn it on, note that the P3 portrait is prompted for a "plain neutral
  background" (`packages/pipeline/src/prompts.ts`), which yields an opaque plate rather
  than a keyed cutout, so it lands as a rectangle. A real sprite asset with an alpha
  channel has not been built
  ([`../plans/archive/INDEX.md#portrait-overlay-opt-in`](../plans/archive/INDEX.md#portrait-overlay-opt-in)).
- **Asset refs are `{hash, ext}`**: the runner resolves them and never inlines them. A
  missing asset is omitted rather than treated as an error, so a partially generated or
  ungenerated project still plays with a placeholder background and portrait.
- **`@vn/export` is a boundaries-constrained leaf**: like `@vn/authoring`, it must not
  import `@vn/pipeline` or `@vn/scheduler`.
- A line belongs to the first shot that covers it, which is why the coverage timeline
  refuses double coverage rather than silently hiding the second shot's frame — see
  [`desktop-app-editors-story.md`](desktop-app-editors-story.md#shot-coverage).

## The web export

The same playable renders as a static light-novel site: one HTML page per scene, with
`choices` and `next` as ordinary links. The app can install a GitHub Actions workflow that
publishes it to GitHub Pages, so a generated VN is readable in a browser without the
desktop runner.

`renderSite(playable)` (`packages/export/src/site.ts`) is "pure" (side-effect free): it
returns the pages to write and the assets to copy, and touches no filesystem. It reads
only the playable, never `Scene`/`Shot`; export already applied the coverage rules.
`renderSite` emits each `say` beat mechanically as a speaker and a line, and nothing in
the path rewrites prose or calls a model.

Three contracts follow:

- **`site.ts` is not re-exported from the package barrel.** Its only consumer is
  `site-cli.ts`, and re-exporting it would pull an HTML template and a stylesheet into the
  desktop main bundle.
- **`site-cli.ts` validates by hand rather than through `playableSchema`.** This is the
  one place where the repo deliberately does not follow its "validate at the boundary with
  zod" rule. The module is bundled into a file committed to an author's git repository,
  and bundling zod grows that file from 275 lines to 4,688. `asPlayable` checks the fields
  the renderer reads and names the one that is wrong. The input is a file the same
  toolchain wrote one step earlier.
- **The renderer is copied into the project.** Every package here is `private: true`, so a
  CI runner cannot `npx vngen`. `scripts/esbuild.sitebuilder.mjs` bundles `site-cli.ts`
  with no externals into `apps/desktop/dist/main/vn-site.mjs`, and `project.installPages`
  writes that file into the project as `.vnstudio/pages/vn-site.mjs`. CI runs it with
  plain `node` and does no install.

[`../guides/github-pages.md`](../guides/github-pages.md) describes what lands in the
author's repository and what the workflow does with it.
