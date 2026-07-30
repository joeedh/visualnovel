# A shared scene-edit package (`@vn/scriptedit`)

Status: **partial** — the package exists and the pure halves (`lineops`, `shotfallout`) live in it;
the sources helper and the write path are still in the desktop session. A prerequisite carved out of
[`scene-editing-commands.md`](scene-editing-commands.md) step 6, which cannot be done as written:
the rules it says to route the agent tool through live in `apps/desktop/src/shared/lineops.ts`, and
a package may not import an app. This plan moves the scene-edit decision rules **and their write
path** into a package both hosts can reach, changing no behaviour.

<!-- toc -->

<!-- tocstop -->

## The problem, exactly

Plan 5 step 6 says: "`edit_scene` in `@vn/authoring`'s registry, routed through the same `lineops`
decisions, so `vnauthor` is not the one writer that goes around them." The decisions are in the
desktop app. So today there are three possible outcomes and two of them are bad:

- **Duplicate the rules in `@vn/authoring`.** Two answers to "what does a split do", drifting apart
  from the first bug fixed in one of them. This is the failure the whole `shared/` arrangement — one
  rule module, run by the surface and by the command — exists to prevent.
- **Let the agent write chunks with `write_file`.** A whole-file overwrite with no validation, which
  is exactly the path that writes duplicate line ids and strands storyboards. Step 6 already says
  `write_file` must *refuse* `scenes/`.
- **Move the rules somewhere both can import.** This plan.

## Where it goes, and why not somewhere cheaper

A new package, `@vn/scriptedit`, allowed `types, util, parse, model, store` — the same allow-list as
`@vn/export`, and input-side for the same reason. Two cheaper homes were considered and rejected:

- **`@vn/model`.** It is the natural home for the *rules* (it already owns `sceneToDoc`,
  `sceneFromDoc` and the branch patchers), but not for the write path: applying an edit reads and
  writes `work/shots/<sceneId>.json` and needs `ProjectPaths`, and `model` may not import `store`.
  Splitting the pure half into `model` and leaving each host its own apply loop puts the storyboard
  carrying — the part that silently loses paid-for art when it is wrong — in two places.
- **`@vn/authoring`.** It has both `model` and `store`, and the desktop already depends on it, so it
  would compile. But it is the *agent* package (workspace index, tool registry, ReAct loop, plan
  mode), and the desktop's `story.*` write path importing the agent to write a scene inverts what
  that package is. A reader would trip over it, and the layering table would have to explain it.

## What moves

Everything below is a move, not a rewrite. Behaviour, messages and tests stay as they are; the
tests move with the code, since a `tests/` sibling is where jest looks.

| From                                             | To                                       |
| ------------------------------------------------ | ---------------------------------------- |
| `apps/desktop/src/shared/lineops.ts`             | `packages/scriptedit/src/lineops.ts`     |
| `apps/desktop/src/shared/shotfallout.ts`         | `packages/scriptedit/src/shotfallout.ts` |
| `session.ts`'s `SceneSource`, `sourcesOf`, `chunkText`, `stateOf` | `packages/scriptedit/src/sources.ts`     |
| `session.ts`'s `planSceneEdit` + the write half of `editScene`    | `packages/scriptedit/src/apply.ts`       |

`sourcesOf`/`chunkText` move even though this plan is about prose edits, because `editBranches`
shares them — leaving them behind would mean the branch write path and the prose write path derive
their target files two different ways, which is the one thing
["a writer patches the file the model was built from"](../pipeline-contracts.md) forbids.

What stays in the desktop app: `loadProject` (it also opens the asset store and the task graph),
`relPath`, `storyGraphOf`, the `story.*` commands, `interactions.ts`, and `branchops.ts` (no agent
tool rewires branches yet; when one does, it follows the same route).

## The seam

`apply.ts` takes what it needs rather than a `LoadedProject`, which is the desktop's own shape:

```ts
planSceneEdit(input: SceneEditInput, decide: (state: ScriptState) => LineOp): Promise<ScenePlan>
applySceneEdit(input: SceneEditInput, plan: AppliedPlan): Promise<{ written: string[]; removed: string[] }>
```

where `SceneEditInput` is `{ paths: ProjectPaths; sources: SceneSource[]; entry?: string }` — the
three things the decision and the patch both need, all derived from the *same* `loadInputs` result
by the caller. `written`/`removed` come back as absolute paths; making them workspace-relative stays
the host's job, because `vnauthor` and the desktop report them differently.

## Steps

1. **Scaffold the package** ✔ — `packages/scriptedit/{package.json,src/index.ts}`, the `ALLOWED`
   entry and `boundaries/elements` pattern in `eslint.config.mjs`, the jest project, and the root
   `tsconfig` path.
2. **Move the pure halves** ✔ — `lineops.ts` and `shotfallout.ts` with their tests, unchanged but
   for imports. `@vn/desktop` re-points `interactions.ts`, `commands/story.ts` and `session.ts` at
   `@vn/scriptedit`. Green here proves the move was a move.

   As shipped, 1 and 2 are **one commit**: a package with a jest project and no tests in it fails
   `pnpm test` outright, so the scaffold is only green with the move on top of it. No per-package
   `tsconfig.json` either — internal packages are source-only and the root `tsconfig` is what
   type-checks them. The move is a `git mv` plus one doc-comment line (`shared/` → package, and
   why), and the two suites keep their `../lineops.js` imports because `src/tests/` sits at the same
   depth. Proven, rather than assumed, with a throwaway `import … from '@vn/pipeline'` in
   `lineops.ts`: `boundaries/element-types` rejected it as `'scriptedit' → 'pipeline'`, so the new
   element really is classified — an unresolved import would have passed silently.
3. **Move the sources + write path** — `sources.ts` and `apply.ts`. `session.editScene` /
   `previewSceneEdit` become thin: load, delegate, relativize, reload. `editBranches` takes
   `SceneSource`/`chunkText` from the package.
4. **Docs** — `CLAUDE.md`'s layering diagram and package table, `docs/index.md`, this file's
   As-shipped section, and plan 5's step 6 (which stops being blocked).

Then plan 5 step 6 proceeds: `edit_scene` in `@vn/authoring` over `@vn/scriptedit`, and `write_file`
refusing `scenes/`.

## Not in this plan

- **No behaviour change.** Not one message, refusal or file layout. A diff that changes what an edit
  *does* belongs in plan 5, where it can be reviewed as a decision rather than as a move.
- **Moving `branchops.ts`.** It has no second caller yet. Moving it "while we're here" would put a
  module in a package on speculation.
- **The agent tool itself.** Plan 5 step 6, immediately after this.
- **A `Shot`-aware model build.** The model still carries no shots; `apply.ts` reads them off disk
  exactly as `planSceneEdit` does today.
