# Test fixtures — `@vn/testkit`

A test-only package that builds real VN projects on disk, runs them through the real
scheduler with mock providers, and hands back the resulting `dir` / `paths` / `model` /
`store` / `graph` / `git`. Prerequisite for
[`desktop-editors-tracking`](desktop-editors-tracking.md) plans 1–4, which assert against
on-disk generated state that no current fixture produces.

## Why

The primitives all exist. What is missing is the composition.

- **`@vn/providers`' mocks are already good.** `createMockProviders({ reviewResponses,
  refLoader })` (`packages/providers/src/mock.ts:62`) gives deterministic offline
  generation with scriptable blocking verdicts. Nothing needs inventing there.
- **A fully-generated project is reachable today — as 50 inlined lines in one test.**
  `scheduler.test.ts:67` runs `runPipeline` against a `mkdtemp` dir and produces real
  `build/assets/`, `manifest.json`, `tasks.jsonl`, gate transitions and `shot.attempts`.
  That is the capability every editor plan wants; it is not packaged, and it starts from
  an in-memory model rather than from disk.
- **Twelve test files call `mkdtemp` independently**, each with its own builder and
  cleanup: `config`, `store`, `git`, `taskgraph/resume`, `scheduler`, `authoring`
  (`tools`, `context`, `loop`, `skills`), `apps/cli`, `apps/authoring`,
  `apps/desktop/sessionstore`. Roughly five of those build something project-shaped; the
  rest just want a scratch directory.
- **Two incompatible fixture styles.** On-disk inputs (`apps/cli/src/tests/commands.test.ts:12`
  — one character, one scene, no choices, no git) versus hand-built in-memory
  `ProjectModel` literals (`pipeline.test.ts:21-61` and `scheduler.test.ts:11-53` duplicate
  near-identical `character()` / `location()` / `scene()` / `model()` factories;
  `playable.test.ts:34` takes a third route through `parseFountain` + `buildModel`).
- **No end-to-end "on-disk inputs → run → assert on-disk state" test exists.** `cmdRun --mock`
  is a dry run by design, so the CLI suite never exercises the write path.

### What the editor checklists need that nothing provides

| Checklist item | Missing capability |
| -------------- | ------------------ |
| 2 · "Edge rewire changes only marker lines in `git diff`" | a **git-initialized** project with a **multi-scene branching** screenplay |
| 2 · "`vngen graph` and the editor agree" | on-disk inputs → model, asserted both directions |
| 3 · "Acceptable at 300 nodes" | a **synthetic scale generator** |
| 1 · "`reviews` validated at the main-process boundary" | `vngen/state/reviews/` written by a completed mock run |
| 4 · "Round-trip verified through `story.play.json`" | a project that has actually been *run*, not just planned |

Related gap, in scope for Wave 4: **`apps/desktop/src/main/session.ts` has no tests at all.**
It is the main-process join point every `view.*` / `story.*` command routes through, and the
desktop jest project covers only the pure command registry and `sessionstore`. Plan 0
restructures the renderer directly above an untested seam.

## Placement

`packages/testkit`, exported as `@vn/testkit`. It is a normal workspace package so it
inherits the existing wiring: jest's `^@vn/([^/]+)$` `moduleNameMapper` and the root
tsconfig's `include` (`packages/*/src/**/*.ts`) both pick it up with no change.

It imports across every layer — `store`, `model`, `scheduler`, `pipeline`, `providers`,
`git` — which the boundaries rule forbids by default. Two mechanisms exist; take the
explicit one:

- **Chosen:** a new `{ type: 'testkit', pattern: 'packages/testkit', mode: 'folder' }`
  element with a rule allowing it to import everything, and **no** rule granting anyone
  permission to import `testkit`. Because `boundaries/element-types` defaults to
  `disallow`, production code importing it is a lint error automatically, while tests are
  unaffected (`eslint.config.mjs:161` already turns the rule off for `**/*.test.ts`).
- **Rejected:** hiding the source under a `__fixtures__/` directory to reuse the escape
  hatch already present but unused at `eslint.config.mjs:161`. It works, but it disables
  the rule rather than expressing the intent.

The package must never be added to any app's `dependencies`, and nothing under `apps/*/src`
outside a `tests/` folder may import it.

## API

```ts
import { makeProject, synthProject, SCRIPTS } from '@vn/testkit';

const p = await makeProject({
  characters: ['aiko', 'haruki'],
  script: SCRIPTS.branching,
  git: true,
});
try {
  await p.run();                       // real runPipeline + createMockProviders
  await p.approve('aiko');             // writes character.md AND store.accept()
  await p.run();                       // gate clears; shots render
  expect(await p.diff('screenplay/')).toBe('');
} finally {
  await p.cleanup();
}
```

```ts
export interface MakeProjectOptions {
  title?: string;
  /** Merged into the generated project.yaml. */
  config?: Record<string, unknown>;
  /** A bare id gets sensible defaults; a spec overrides front-matter fields. */
  characters?: (string | CharacterSpec)[];
  /** Defaults are inferred from the script's scene headings when omitted. */
  locations?: (string | LocationSpec)[];
  /** Fountain source. Default: SCRIPTS.branching. */
  script?: string;
  /** git init + a deterministic identity + an initial commit of the inputs. */
  git?: boolean;
  /** Extra files, keyed by path relative to the project root. */
  files?: Record<string, string>;
}

export interface TestProject {
  readonly dir: string;
  readonly paths: ProjectPaths;
  /** Undefined unless `git: true`. */
  readonly git?: Git;

  /** Re-read everything from disk. Call after any edit; `run` does it for you. */
  reload(): Promise<{
    config: ProjectConfig;
    model: ProjectModel;
    store: AssetStore;
    graph: TaskGraph;
  }>;
  /** Reload, then run the real scheduler with mock providers. */
  run(opts?: { dryRun?: boolean; reviewResponses?: string[] }): Promise<RunSummary>;
  /** Approve a portrait the way `vngen approve` does: front-matter + store.accept. */
  approve(characterId: string, hash?: string): Promise<string>;

  write(rel: string, content: string): Promise<void>;
  read(rel: string): Promise<string>;
  /** `git diff` over the working tree. Throws when the project has no repo. */
  diff(pathspec?: string): Promise<string>;
  cleanup(): Promise<void>;
}
```

### Named scripts

One shared vocabulary, so a test names the topology it needs instead of inlining fountain:

| Constant | Shape |
| -------- | ----- |
| `SCRIPTS.linear` | two scenes joined by `[[next:]]` |
| `SCRIPTS.branching` | the four-scene fork at `playable.test.ts:34`, reused verbatim so that test can migrate without changing its assertions |
| `SCRIPTS.diamond` | a fork that rejoins — exercises layout and reachability together |
| `SCRIPTS.orphan` | an unreachable scene, driving the dead-scene diagnostic |

### `synthProject`

```ts
const big = await synthProject({ scenes: 150, fanout: 2, characters: 3 });
```

Deterministic generation only — **no randomness**. Task identity is
`sha256(kind, inputs)`, so a randomized script would produce a different task set on every
run and make the plan-3 scale check unreproducible.

## Known wrinkles

Recorded here because each one is a trap the implementation must handle, not a detail to
discover later.

- **The 300-node DAG requires a real run, not a dry run.** `runPipeline` with `dryRun`
  returns after a single `planTasks` call (`scheduler.ts:64`), and planning is incremental
  — shot tasks only appear once their upstream location tasks are `done`. Reaching 300
  nodes means executing the mock run to completion. Budget for ~300 small file writes; if
  that proves slow, the fix is a store-level fake, not a randomized shortcut.
- **`scenes: N` is not `nodes: N`.** Each scene contributes a shot plus shared location and
  portrait tasks. Tests should assert on `graph.all().length`, and `synthProject` should
  document the observed ratio rather than pretending to hit an exact node count.
- **Approval must go through disk.** `scheduler.test.ts:90` approves by mutating the
  in-memory model. `TestProject.approve` writes `character.md` via `setCharacterApproval`
  *and* calls `store.accept`, so the next `reload()` observes it — that fidelity is the
  point of the fixture.
- **git needs a local identity.** `git init` in a temp dir inherits nothing, so commits
  fail on a clean box. `git.test.ts:11-27` already solves this and reaches through a cast
  to the private `Git.run` three times to do it. Testkit absorbs that cast once, including
  `core.autocrlf false` so byte-exact diffs hold on Windows.
- **Do not import `apps/cli`.** `loadProject` / `buildProviders`
  (`apps/cli/src/project.ts`) are exactly the wiring testkit needs, but apps are not
  libraries — `session.ts` makes the same call and re-implements the glue deliberately.
  Testkit re-implements the dozen lines too.
- **Mock runs produce fake image bytes.** They are fine for structure, coverage math and
  round-trips; they are not fine for anything asserting on real pixels, and they must never
  be mixed into a real run's reference assets.

## Waves

### Wave 1 · The package

Scaffold `packages/testkit` (package.json mirroring `packages/debug2d`'s shape), add the
tsconfig `paths` entry, add `'testkit'` to `PACKAGES` in `jest.config.cjs`, and add the
boundaries element type plus its allow-everything rule.

### Wave 2 · `makeProject`

Input-file writers (`project.yaml`, `characters/<id>/character.md`, `locations/<id>.md`,
`screenplay/script.fountain`), the `SCRIPTS` constants, `reload` / `run` / `approve` /
`write` / `read` / `cleanup`, and the optional git init. Testkit gets its own suite — a
fixture builder that lies is worse than no fixture — covering: a built project loads with
no error diagnostics; `run` reaches the gate then clears it after `approve`; `git: true`
yields a clean tree; `cleanup` removes everything.

### Wave 3 · `synthProject`

Deterministic scale generation, with a test pinning the scenes-to-tasks ratio so plan 3's
budget is grounded in a measured number.

### Wave 4 · Migration

Move the existing fixtures over, deleting the bespoke builders as each lands:

| Test | Change |
| ---- | ------ |
| `apps/cli/src/tests/commands.test.ts` | `tempProject()` → `makeProject` |
| `packages/scheduler/src/tests/scheduler.test.ts` | in-memory model + `withProject` → `makeProject` + on-disk `approve` |
| `packages/pipeline/src/tests/pipeline.test.ts` | keep the in-memory literals (unit tests of pure planners); import the shared `character()` / `location()` / `scene()` factories from testkit |
| `packages/export/src/tests/playable.test.ts` | inline `SCRIPT` → `SCRIPTS.branching` |
| `packages/store`, `packages/config`, `packages/taskgraph` | adopt `makeProject` only where a real project is wanted; a bare scratch dir stays a bare scratch dir |
| `packages/git`, `packages/authoring`, `apps/desktop/sessionstore` | unchanged — not project-shaped |

Then add the missing end-to-end coverage the migration makes cheap: **on-disk inputs → run
→ assert on-disk state**, and a first `WorkspaceSession` test.

## Checklist

- [ ] `packages/testkit` builds, typechecks, and has its own green jest project
- [ ] Boundaries: testkit may import anything; production importing testkit is a lint error
- [ ] `makeProject` produces a project that loads with zero error diagnostics
- [ ] `run` → gate → `approve` → `run` clears the gate, on disk, from disk
- [ ] `git: true` yields a clean tree and byte-exact diffs on Windows
- [ ] `SCRIPTS.branching` is byte-identical to the constant `playable.test.ts` uses today
- [ ] `synthProject` is deterministic across runs; scenes-to-tasks ratio pinned by a test
- [ ] All twelve `mkdtemp` sites reviewed; the project-shaped ones migrated
- [ ] One end-to-end on-disk run test exists
- [ ] One `WorkspaceSession` test exists
- [ ] `pnpm check`, `pnpm test`, `pnpm lint` green
- [ ] `CLAUDE.md` documents `@vn/testkit` (package table + a testing note)
- [ ] Debug lessons appended to
      [`../research/debug-lessons-learned.md`](../research/debug-lessons-learned.md) — see
      [Debug lessons](desktop-editors-tracking.md#debugging-lessons)
