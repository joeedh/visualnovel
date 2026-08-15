# The agent revises art: notes, regeneration, and reading the picture back

Status: **planned**

## Context

`todos.md`:

> if the agent is told to change an artwork asset it should have the tools not just to append to
> the art notes but also to ask the user if it can regenerate it, and if so read back the image and
> propose further changes to the art notes to get the desired results.

Today `vnauthor` has thirty tools and **none of them touch a planned asset**. `generate_image`,
`edit_image` and `list_images` all address *concepts* — the deliberately unplanned sketches from
[`on-demand-concept-images.md`](on-demand-concept-images.md). The agent cannot set an art note,
cannot list a portrait, cannot requeue anything, and cannot look at an image at all. Asked to make
the café read more brutalist, the best it can do is rewrite the location sheet's prose and hope.

Three things are needed, and each has a different obstacle.

**1. Art notes.** The rung vocabulary (`character:aiko/gala`, `location:cafe/night`,
`shot:greet/s2`) is parsed by `apps/desktop/src/main/artnotes.ts` — 138 pure lines, in an app. A
package cannot import an app, so the agent cannot reuse it, and a second parser would be a second
answer to "which rung did you mean". This is the same situation that produced `@vn/scriptedit`:
two hosts must run one rule, so the rule belongs to neither.

**2. Regeneration.** `asset.regenerate` requeues the task and optionally runs the pipeline —
through `session.regenerateAsset` and `session.runPipeline`, both of which reach `@vn/pipeline` and
`@vn/scheduler`. `@vn/authoring` is **forbidden** from importing either, and that ban is the shape
of the whole project, not an inconvenience to route around.

**3. Reading the image back.** `VisionReviewer` exists (`ChatVisionReviewer` in `@vn/providers`,
which `@vn/authoring` *may* import) — but its signature is `review(image, spec: ShotSpec, refs)`.
It is shot-shaped: it is told what the shot ordered and asked for defects against it. A portrait,
a model sheet or a location plate has no `ShotSpec`, and a question like "does this read as
brutalist yet?" is not a defect report. So the P7 loop is **not** the thing to reuse, and it does
not need to move: what is missing is a plain vision question over the `ChatBackend` seam that
`ChatVisionReviewer` already sits on.

## Decisions this plan settles

- **`artnotes.ts` moves to `@vn/artgen`, rules and write path together.** `@vn/artgen` already
  holds art policy shared by the pipeline, the desktop and `vnauthor`, and already writes entity
  sheets through `@vn/model`'s `apply*Edit` (that is what `promote.ts` does). The desktop's
  `session.setArtNotes` becomes a thin call, and the agent tool is a second thin call. One rung
  parser, one write path, one set of refusals.
- **Regeneration is an injected capability, exactly like `art?: ArtGen`.** `ToolContext` gains
  `pipeline?: PipelineControl` with `regenerate(hash)` and `run()`. The desktop wires it (main
  already imports the pipeline); the REPL leaves it undefined and the tool refuses by name:
  *"regenerating a planned asset runs the pipeline, which vnauthor does not do — open the project
  in the desktop app."* The precedent is already in the file: *"Absent in bare contexts, in which
  case `generate_image` and `edit_image` refuse rather than assume an API key exists to spend."*
  This keeps the boundaries rule intact instead of arguing with it.
- **`regenerate_asset` is `confirm: true`, always.** It spends a real image generation. The
  always-confirm sentence goes in `apps/desktop/src/main/toolconfirm.ts` beside the existing five,
  naming the asset and what it costs — the default confirm sentence exists so an unknown tool is
  not *easier* to allow, and a new one must not lean on it.
- **The vision read-back is a new, general call in `@vn/artgen`, not a change to `VisionReviewer`.**
  `describeAsset(hash, question)` → one paragraph. `VisionReviewer`'s contract is P7's and the
  refine loop depends on its structured `DefectReport`; widening it to serve a free-form question
  would put two jobs in one interface and one of them in the task graph's hot path.
- **The agent proposes notes; it does not silently iterate.** After a read-back it returns a
  *suggested* `set_art_notes` call, and setting one is a mutating tool subject to the plan gate
  like everything else. An agent that regenerates, looks, and regenerates again on its own is a
  loop that spends money without a turn boundary, and the plan/execute gate is precisely where
  this project puts that decision.
- **A read-back is only offered for bytes that exist.** An asset whose task is queued but not run
  has nothing to look at; the tool says so rather than describing the previous render.
- **Every rung the agent can write is a rung the author can see.** No new rungs, no agent-only
  field. `artNotes` at the five existing rungs, and the asset editor already renders them.

## Stage 1 — move the rules

1. `apps/desktop/src/main/artnotes.ts` → `packages/artgen/src/artnotes.ts`, unchanged apart from
   its imports. Its tests move with it.
2. New `packages/artgen/src/setnotes.ts`: `artNotesOf(model, target)` (the two-layer refusal shape
   `promotionOf`/`uploadOf` use) and `setArtNotes(deps, {target, notes})` doing what
   `session.setArtNotes` does today — `applyCharacterEdit` / `applyLocationEdit` for the entity
   rungs, the `work/shots/<sceneId>.json` writer for the shot rung. `art.setNotes` stays one of the
   four writers of that file; the writer just lives one layer down.
3. `session.setArtNotes` and `previewArtNotes` delegate. `apps/desktop/src/main/artnotes.ts`
   becomes a re-export or disappears; either way `rungsFor` keeps serving the asset editor.

No behaviour changes in this stage, and that is the acceptance test: the asset editor's rung strip
and `art.setNotes`'s refusals are byte-identical before and after.

## Stage 2 — the read-back

New `packages/artgen/src/describe.ts`:

```ts
export interface DescribeRequest { hash: string; question?: string }
export interface DescribeResult { hash: string; label: string; answer: string }
export async function describeAsset(deps: { store; backend }, req): Promise<DescribeResult>;
```

Over the `ChatBackend` seam directly (one image, one question, free text back). The default
question is *"Describe this image: subject, framing, palette, style, and anything that looks
wrong."* A mock backend answers deterministically, so the tool is testable offline like every
other generative step here.

`ArtGen` (`packages/authoring/src/art.ts`) gains `describe(req)`, wired in `workspaceArtGen` from
the same config that already builds the image backend.

## Stage 3 — the tools

`packages/authoring/src/tools.ts`:

| tool | mutating | confirm | what |
| --- | --- | --- | --- |
| `list_assets` | no | — | Planned assets for a subject (`character:aiko`, `location:cafe`, `scene:greet`): hash, label, kind, accepted, and whether its bytes exist. Without this the agent cannot name what it wants to change — `list_images` covers concepts only |
| `art_notes` | no | — | The rungs that reach an asset and what each says today — `rungsFor`, which is the context any proposal needs |
| `set_art_notes` | yes | — | Write a rung: `append` (default), `replace`, or `clear`. Appending is the common case and the todo's word |
| `view_image` | no | — | `describeAsset`. Costs a vision call, which is why it is a tool the agent chooses and not something done automatically after every regeneration |
| `regenerate_asset` | yes | **yes** | Requeue and optionally run, through `ctx.pipeline`. Refuses when the capability is absent, and refuses a concept and an upload by name, because `asset.regenerate` does |

`ToolContext` gains the optional `pipeline` capability with the same doc-comment shape `art` has.
`apps/desktop/src/main/toolconfirm.ts` gains a `regenerate_asset` sentence.

The intended shape of a turn, which the tool descriptions should make obvious:

> `list_assets(subject='location:cafe')` → `art_notes(hash=…)` → propose → *approve plan* →
> `set_art_notes(target='location:cafe' notes='…brutalist…')` → `regenerate_asset(hash=… run=true)`
> *(confirm)* → `view_image(hash=…)` → propose the next note.

## Stage 4 — the desktop's side

- `session.ts` builds `ToolContext.pipeline` from the methods `asset.regenerate` already calls.
- The agent's writes already flow to open editors through the `onWrote` bus, so an art-notes edit
  refreshes the asset pane with no new plumbing.
- A regeneration started by the agent uses the same busy flag a pipeline run does, so the composer
  closes and `workspace.*` refuses while it is in flight — a conversation that can switch projects
  mid-render is a corrupt run.

## Stage 5 — documentation

- `docs/vnauthor.md`: the five new tools, the capability-gated one, and the intended turn shape.
- `docs/packages.md`: `@vn/artgen` now also owns the art-notes rungs and the vision read-back.
- `CLAUDE.md`: the `@vn/artgen` row gains art notes and `describeAsset`; the art-direction
  invariant gains "and the agent reaches the same rungs, through the same refusals".

## Acceptance

- `pnpm check`, `pnpm test`, `pnpm lint` green.
- Told "make the café more brutalist", the agent in the desktop plans a `set_art_notes` on
  `location:cafe`, and after approval the note is on the sheet and the plate's task is re-keyed.
- `regenerate_asset` in the REPL refuses with the sentence naming the desktop app.
- `view_image` on an asset whose bytes are not rendered yet refuses; on one that is, it answers.
- The asset editor's rung strip and every `art.setNotes` refusal are unchanged by the Stage 1 move.
- A project that authors no art notes still produces byte-identical prompts — the test that
  matters for anything touching this path.
