# Portrait overlay: opt-in, not the default

Status: **shipped.** See [As shipped](#as-shipped).

## The problem

Watch a generated scene in PLAY and some frames show each character twice: once painted into
the shot image, and once again as a portrait pasted over the top, at the wrong scale, on an
opaque rectangle of its own background.

Both halves are working as written, which is the point:

- `buildShotPrompt` (`packages/pipeline/src/prompts.ts`) names the shot's subjects — "Subjects:
  Aiko, wearing uniform, pose: …" — so a shot with a cast **is** a picture of that cast in that
  location. The shot is the whole frame, not a background plate. (Only `buildLocationPrompt`
  asks for "No characters", and location plates are references, not beats.)
- `Runner.tsx` nonetheless draws `play.characters[speaker].portrait` over every frame with a
  speaker, unconditionally (`apps/desktop/renderer/rooms/play/Runner.tsx:185`). That is the
  classic VN staging — a background plus a sprite — and it is the right thing for a project
  whose art is authored that way. It is the wrong thing here.

The bad keying is downstream of the same mismatch: the P3 portrait prompt asks for a "plain
neutral background, head-and-shoulders framing" (`prompts.ts:30`), so the asset is an opaque
plate. Nothing in the pipeline produces a keyed cutout, and CSS cannot invent an alpha channel.

## The decision

**The shot is the whole picture; the overlay is opt-in.** A new `portrait_overlay` in
`project.yaml`, default `false`, carried into `story.play.json` as `portraitOverlay` so the
presentation choice travels with the export rather than living only in one app's UI.

Keying is **deferred and documented**, not fixed: a correct overlay needs a transparent-
background sprite asset (new prompt, new task kind, provider support for alpha), which is a
larger change than this one and is only worth making for a project that wants the staging. The
limitation is written down where an author who flips the flag will meet it.

## Steps

Each step is one commit and leaves `pnpm check` / `pnpm test` / `pnpm lint` green.

### 1. The two schema fields ✅

- `packages/types/src/schemas.ts` — `projectConfig` gains
  `portrait_overlay: z.boolean().default(false)`, documented with _why_ the default is off (the
  shot already contains its subjects) and what the author gets if they turn it on (an opaque
  plate, until sprites exist).
- `packages/types/src/playable.ts` — `playableSchema` gains
  `portraitOverlay: z.boolean().default(false)`. The default rather than `.optional()` so the
  parsed type is a plain `boolean` for every consumer, and a `story.play.json` written before
  this field still parses.
- `packages/config/src/tests/config.test.ts` — the default is pinned beside the others.

### 2. Thread it through the exporter ✅

`buildPlayable`'s optional third argument becomes an options object — two optional positionals
where the second is a bare boolean reads worse than one named bag, and `shots` is the only
existing caller-supplied extra:

```ts
export interface PlayableOptions {
  shots?: ReadonlyMap<string, readonly Shot[]>;
  portraitOverlay?: boolean;
}
buildPlayable(model, store, opts: PlayableOptions = {});
```

The flag is emitted **always**, not omitted when false: unlike an asset ref, whose absence means
"not generated yet", this one is a knob, and an author reading `story.play.json` should be able
to see it is there and off.

Call sites (`apps/cli/src/commands.ts` `cmdExport`, `apps/desktop/src/main/session.ts`
`playable()` and `exportPlayable()`) already hold `project.config`, so each passes
`portraitOverlay: project.config.portrait_overlay`. `vngen export` prints one extra line when
the overlay is on, and nothing extra when it is off.

Tests: `packages/export/src/tests/playable.test.ts` — off by default, on when asked, and the
character's `portrait` ref is exported eitherway (the flag governs presentation, not the asset).

### 3. The runner obeys it ✅

`Runner.tsx` resolves a portrait only when `play.portraitOverlay` is set. One guard at the
render site; `framesOf` keeps tracking `portraitWho`, which stays correct and costs nothing.

The desktop jest project is node-only, so the component itself is untested — but the real
regression risk is the *threading* (a `buildPlayable` call that forgets the config), and that is
main-process code. `apps/desktop/src/main/tests/session.test.ts` pins `play.portraitOverlay`
coming back off from a default workspace.

### 4. Docs ✅

- `docs/playable-format.md` — `portraitOverlay` in the shape block, the new `buildPlayable`
  signature, and a contract bullet: **the shot is the whole picture, so the overlay is opt-in**,
  including the honest note that an author who opts in today gets an unkeyed plate.
- `docs/desktop-app.md` — one bullet under "The runner (PLAY)".
- `docs/plans/index.md` — the row for this plan.
- This file — tick the steps, add `## As shipped`.

## As shipped

Four steps, as planned, with three things the plan did not say:

- **`renderer/api.ts` holds a fourth playable.** `MOCK_PLAYABLE`, the fixture that lets PLAY
  render in a plain browser, is a `Playable` literal — so a defaulted (not optional) field made
  it a typecheck failure, caught only by `pnpm check:renderer`. It now carries
  `portraitOverlay: false` like everything else. Worth remembering: the renderer's second tsgo
  pass is the only thing that reads that file.
- **`vngen export` says so when the overlay is on**, and stays silent when it is off. A flag
  that changes what a runner draws but leaves no trace in the command that wrote it is the kind
  of thing an author sets once and then cannot explain.
- **The runner's guard is at the render site, not in `framesOf`.** `Frame.portraitWho` still
  tracks the last speaker whether or not anything is drawn, so the fold stays a description of
  the story and the flag stays a description of the staging.

The unkeyed-portrait limitation is **documented, not fixed** — see
[`playable-format.md`](../../playable-format.md#contracts), which warns an author at the point they
would flip the flag rather than leaving them to discover it in a frame.

## Out of scope

- **Keyed sprites.** A transparent-background character sprite asset (prompt, task kind,
  provider alpha support, and the model-sheet-vs-portrait question of which asset a sprite
  should derive from). Deferred deliberately; see the decision above.
- **Per-scene or per-character overlay control.** One project-level flag.
- **Changing what a shot depicts.** `buildShotPrompt` keeps naming its subjects — the frames
  containing the cast is the behaviour being kept, not the bug.
- **A runtime toggle in PLAY.** The flag is a property of the project; `view.*` could grow a
  session override later if watching with it on and off turns out to be a thing anyone does.
