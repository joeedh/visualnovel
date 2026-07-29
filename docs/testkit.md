# Test fixtures (`@vn/testkit`)

A test-only package that builds **real projects on disk** and runs them through the **real
scheduler** with mock providers, so a test asserts against generated state rather than a
hand-built model. Plan: [`plans/test-fixtures.md`](plans/test-fixtures.md).

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

**In-memory factories** (`character`, `location`, `scene`, `model`) are also exported, for unit
tests of the pure planners where building on disk would just be noise.

## Contracts

- **Fidelity is the point.** Every method goes through the code path production uses — inputs
  are parsed from files, approval is written to front-matter, the scheduler runs for real — so
  a fixture cannot pass by being kinder than the app. `characters`/`locations` are inferred from
  the script by the same `splitScenes` the model build uses, so ids can't drift.
- **Nothing may import it.** The boundaries rule grants `testkit` permission to import every
  layer and grants no one permission to import `testkit`; since `boundaries/element-types`
  defaults to `disallow`, a production import is a lint error. Test files are exempt from the
  rule, which is the only place it belongs. It must never appear in an app's `dependencies`.
- **The gate is per scene.** A scene with no cast renders on the _first_ run, before any
  approval. Assert on `summary.blockedOnGate` / `summary.gate.pending` / specific shot ids —
  never on "no shots ran".
- **`synthProject({ scenes, fanout, characters, locations })`** generates a `fanout`-ary scene
  tree with **no randomness** (task identity is `sha256(kind, inputs)`; a randomized script
  would change the task set every run). Scenes are not nodes: a fully-run project settles at
  `L + 4C + 2N` tasks, and reaching that total needs a real `run()`, not a `dryRun`.

## Placeholder art and the recorded corpus

- **Mock runs produce placeholder art, and it is marked as such.** `StubImageBackend` emits a
  real 64×36 PNG (`packages/providers/src/placeholder.ts`) — colour and stripe derived from the
  same seed, so a mock project is _viewable_ in the desktop app instead of a strip of broken
  thumbnails, and distinct shots look distinct. The bytes are hand-encoded with stored deflate
  blocks rather than `zlib`, because they are content-addressed and zlib's output is only stable
  per library version. Every placeholder carries a `tEXt` chunk keyed `vn-mock-placeholder`;
  `imagePart` in the Gemini backend rejects any reference carrying it. That marker _is_ the
  "never mix mock assets into a real run" guarantee now — a placeholder decodes fine, so
  magic-byte sniffing can no longer tell it from generated art.
- **`makeProject({ assets: 'cached' })` replays _real_ recorded art** out of
  `packages/testkit/assets/` (`<key>.<ext>` + an `index.json` of provenance), for the fixtures
  that exist to be _looked at_ — the PLAY room, the FLOOR inspector — rather than asserted on.
  The corpus is recorded and committed: **9 entries, 11.3 MB**, covering `linear` end to end.
  `CachedImageBackend` (`@vn/providers`) wraps `StubImageBackend`, keyed on
  `sha256(op, prompt, ordered ref-byte hashes, params)` — not the task hash, since the backend
  never sees a task. Default is `'placeholder'`, so no suite can pass only on a machine that has
  the corpus. Three contracts: a ref's bytes are in both the task hash _and_ the cache key, so
  **a cache is whole-chain or nothing** — a hole misses, and everything downstream of it misses
  too and degrades to placeholders rather than mixing; a hit reports the **recorded** model id,
  because the recording is the authority on its own provenance; and `put` refuses placeholder
  bytes, so a recording run that fell back to mocks can't bake them in. Recording is not
  reachable from `makeProject` — it lives on `CachedImageBackend({ record: true })`, which only
  the refresh script uses.

## Refreshing the corpus

`node scripts/record-fixture-assets.mjs [--fixture linear] [--check]` — a thin driver over
`packages/testkit/src/record.ts`, which is in the package (not the script) so it is typechecked
and inside the boundaries graph.

- **It records image calls only.** Recording runs the fixture with
  `createMockProviders({ imageBackend: cached })`: **mock text and vision, real image model**,
  because P5 decomposition is an LLM step and a recording made against a real text model would
  carry shot descriptions no replaying fixture ever asks for again — the corpus would be dead
  bytes. Mock text pins the run to the deterministic baseline, which is what a replay produces;
  the price is that a recorded P7 loop is one attempt deep.
- **`--check` is free and offline and reports, never gates** — a suite that failed on a stale
  entry would put a paid re-record in the way of an ordinary prompt change. It derives
  reused/missed/orphaned from `CachedImageBackend.log`, and marks the orphan list suspect
  whenever anything missed, since past the first miss the chain constraint re-keys every later
  request.
- **A failed task is a different thing from a stale entry and is never quiet**: `runFixture`
  collects `task.end` errors through a `logger` passed to testkit's `run()` (the scheduler
  stores a failure's message nowhere else — `RunSummary.ran` counts failures as terminal),
  `formatReport` prints them, and the script exits non-zero.
- A full re-record of `linear` is 9 image calls, ~$0.35, and is always full — a changed prompt
  re-keys everything downstream of it.
- **The recorder's bundle location and `cacheDir` are both load-bearing.** The model SDKs are
  `EXTERNAL` and lazy-imported, and `@google/genai` is a dependency of `@vn/providers` alone, so
  the bundle is emitted into `packages/providers/` — from anywhere else node cannot resolve it
  and every image task fails on first use. And `FIXTURE_ASSET_DIR` is `__dirname`-relative,
  which esbuild rewrites to the _output_ directory, so the script passes `cacheDir` explicitly
  rather than letting a bundle write a complete corpus somewhere adjacent and plausible. Both
  cost a paid run to discover; see
  [`plans/sample-workspace-and-asset-cache.md`](plans/sample-workspace-and-asset-cache.md).
