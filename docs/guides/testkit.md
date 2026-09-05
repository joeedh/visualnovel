# Test fixtures (`@vn/testkit`)

This test-only package builds real projects on disk and runs them through the real scheduler
with mock providers, so a test asserts against generated state rather than a hand-built model.
Plan: [`../plans/archive/INDEX.md#test-fixtures`](../plans/archive/INDEX.md#test-fixtures).

<!-- toc -->

- [Using it](#using-it)
- [Contracts](#contracts)
- [Placeholder art and the recorded corpus](#placeholder-art-and-the-recorded-corpus)
- [Refreshing the corpus](#refreshing-the-corpus)

<!-- tocstop -->

## Using it

```ts
import { SCRIPTS, makeProject, synthProject } from '@vn/testkit';

const p = await makeProject({ script: SCRIPTS.branching, git: true });
try {
  await p.run(); // real runPipeline + createMockProviders → halts at the gate
  await p.approveAll(); // writes character.md AND store.accept(), like `vngen approve`
  await p.run(); // gate clears; model sheets + shots render
  const { model, store, graph } = await p.reload();
} finally {
  await p.cleanup(); // always, in a finally
}
```

In-memory factories (`character`, `location`, `scene`, `model`) are also exported. Unit tests of
the "pure" (side-effect-free) planners use them instead of building fixtures on disk, which
would add noise.

## Contracts

- **Every method runs the production code path.** Inputs are parsed from files, approval is
  written to front-matter, and the scheduler runs for real, so a fixture cannot pass under
  looser conditions than the app applies. `characters`/`locations` are inferred from the script
  by the same `splitScenes` the model build uses, so the ids match.
- **Nothing may import `testkit`.** The boundaries rule grants `testkit` permission to import
  every layer and grants no one permission to import `testkit`; since `boundaries/element-types`
  defaults to `disallow`, a production import is a lint error. Test files are exempt from the
  rule, and test files are the only place `testkit` belongs. `testkit` must never appear in an
  app's `dependencies`.
- **The gate is per scene.** A scene with no cast renders on the first run, before any
  approval. Assert on `summary.blockedOnGate`, `summary.gate.pending`, or specific shot ids, and
  never on "no shots ran".
- **`synthProject({ scenes, fanout, characters, locations })`** generates a `fanout`-ary scene
  tree without randomness, because task identity is `sha256(kind, inputs)` and a randomized
  script would change the task set every run. Scenes are not nodes. A fully-run project settles
  at `L + 4C + 2N` tasks, and reaching that total needs a real `run()` rather than a `dryRun`.

- **`p.run({ graphs })`** binds generation graphs to slots for the length of one run. Each
  entry is keyed by the slug its journal and blobs are filed under, and the run indexes them by
  the slot each active output claims. A task whose slot an active output names draws through the
  graph, and every other task runs the path it ran before graphs existed. Two active outputs
  claiming one slot throws by name rather than resolving the conflict by load order. Graphs
  themselves are described in [`../reference/gen-graphs.md`](../reference/gen-graphs.md).

## Placeholder art and the recorded corpus

- **Mock runs produce placeholder art, and it is marked as such.** `StubImageBackend` emits a
  real 64×36 PNG (`packages/providers/src/placeholder.ts`), with colour and stripe derived from
  the same seed, so a mock project is viewable in the desktop app instead of a strip of broken
  thumbnails, and distinct shots look distinct. The bytes are hand-encoded with stored deflate
  blocks rather than `zlib`, because they are content-addressed and zlib's output is only stable
  per library version. Every placeholder carries a `tEXt` chunk keyed `vn-mock-placeholder`, and
  `imagePart` in the Gemini backend rejects any reference carrying it. That marker now enforces
  the guarantee that mock assets never mix into a real run, because a placeholder decodes fine
  and magic-byte sniffing can no longer tell it from generated art.
- `makeProject({ assets: 'cached' })` replays real recorded art out of
  `packages/testkit/assets/` (`<key>.<ext>` plus an `index.json` of provenance), for the
  fixtures that exist to be looked at (the PLAY room, the FLOOR inspector) rather than asserted
  on. The corpus is recorded and committed, with 9 entries and 11.3 MB covering `linear` end to
  end. `CachedImageBackend` (`@vn/providers`) wraps `StubImageBackend`, keyed on `sha256(op,
  prompt, ordered ref-byte hashes, params)` rather than the task hash, since the backend never
  sees a task. The default is `'placeholder'`, so no suite can pass only on a machine that has
  the corpus. Three contracts hold. A ref's bytes go into both the task hash and the cache key,
  so a cache covers the whole chain or nothing at all: a hole misses, and everything downstream
  of it misses too and degrades to placeholders rather than mixing. A hit reports the recorded
  model id, because the recording is the authority on its own provenance. And `put` refuses
  placeholder bytes, so a recording run that fell back to mocks cannot bake them in. Recording
  is not reachable from `makeProject`. It lives on `CachedImageBackend({ record: true })`, which
  only the refresh script uses.

## Refreshing the corpus

`node scripts/record-fixture-assets.mjs [--fixture linear] [--check]` is a thin driver over
`packages/testkit/src/record.ts`. That file lives in the package rather than in the script so
that it is typechecked and inside the boundaries graph.

- **It records image calls only.** Recording runs the fixture with `createMockProviders({
  imageBackend: cached })`, which mocks text and vision and uses the real image model. P5
  decomposition is an LLM step, so a recording made against a real text model would carry shot
  descriptions that no replaying fixture asks for again, and the corpus would hold bytes nothing
  reads. Mock text pins the run to the deterministic baseline, which is what a replay produces.
  The cost is that a recorded P7 loop covers a single attempt.
- **`--check` is free, offline, and reports rather than gates** — a suite that failed on a
  stale entry would put a paid re-record in the way of an ordinary prompt change. It derives
  reused/missed/orphaned from `CachedImageBackend.log`. It marks the orphan list suspect
  whenever anything missed, because the chain constraint re-keys every request after the first
  miss.
- **A failed task is always reported, and is handled separately from a stale entry**:
  `runFixture` collects `task.end` errors through a `logger` passed to testkit's `run()` (the
  scheduler stores a failure's message nowhere else — `RunSummary.ran` counts failures as
  terminal), `formatReport` prints them, and the script exits non-zero.
- A full re-record of `linear` takes 9 image calls and costs about $0.35. Every re-record is
  full, because a changed prompt re-keys everything downstream of it.
- **The recorder's bundle location and `cacheDir` both matter.** The model SDKs are `EXTERNAL`
  and lazy-imported, and `@google/genai` is a dependency of `@vn/providers` alone, so the bundle
  is emitted into `packages/providers/`; node cannot resolve it from any other directory, and
  every image task fails on first use. `FIXTURE_ASSET_DIR` is `__dirname`-relative, which
  esbuild rewrites to the output directory, so the script passes `cacheDir` explicitly rather
  than letting the bundle write a complete corpus into a directory beside the output.
  Discovering either mistake costs a paid run; see
  [`../plans/archive/INDEX.md#sample-workspace-and-asset-cache`](../plans/archive/INDEX.md#sample-workspace-and-asset-cache).
