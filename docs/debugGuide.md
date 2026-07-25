# Debugging guide

<!-- toc -->

- [First: the gates](#first-the-gates)
- [Reading the evidence on disk](#reading-the-evidence-on-disk)
- [Reproducing offline](#reproducing-offline)
- [Debugging the desktop app](#debugging-the-desktop-app)
  * [Drive it from a terminal (CDP)](#drive-it-from-a-terminal-cdp)
  * [UI bugs: ask `window.__vnDebug`, not a screenshot](#ui-bugs-ask-window__vndebug-not-a-screenshot)
  * [DevTools](#devtools)
- [Debugging tests](#debugging-tests)
- [Known traps](#known-traps)

<!-- tocstop -->

How to debug this repo, written for whoever (or whatever) is doing the debugging — the
sections are ordered from cheapest tool to most expensive, and the recurring theme is:
**prefer ground truth (logs, state files, query output) over reproduction and screenshots.**
Most of the system was designed to leave evidence behind; start by reading it.

## First: the gates

Before debugging anything subtle, make sure the boring failures aren't the problem:

```sh
pnpm check                                    # tsgo over the whole workspace
pnpm exec jest --selectProjects @vn/store     # one package's suite, fast
pnpm test                                     # everything
pnpm lint                                     # eslint (boundaries!) + prettier check
```

Things the gates catch that look like deep bugs but aren't:

- **A cross-layer import.** The boundaries rule rejects it — but note the historical
  gotcha: an *unresolved* import is an *unclassified* one, which the rule silently passes.
  If a boundaries violation you expected doesn't fire, suspect resolution (the TypeScript
  resolver in `eslint.config.mjs`), not the rule.
- **Renderer type errors.** Root `pnpm check` does **not** cover `apps/desktop/renderer/`
  (it has its own tsconfig). Check it explicitly:
  `pnpm exec tsgo --noEmit -p apps/desktop/renderer/tsconfig.json`.
- **A missing workspace link** after adding a package — run `pnpm install`, and remember
  the four lists that must all know a new package: root `tsconfig.json` `paths`,
  `jest.config.cjs` `PACKAGES`, `scripts/aliases.mjs` `PACKAGES`, `eslint.config.mjs`.

## Reading the evidence on disk

A `vngen` project leaves a complete audit trail under `<project>/vngen/`. When a run "did
something weird", the answer is usually already written down:

| File | What it tells you |
| ---- | ----------------- |
| `state/tasks.jsonl` | Every task status transition, append-only. Replaying it (last writer wins per task hash) *is* the graph state — if a run resumed strangely, diff what you expected against what's here. |
| `state/commands.jsonl` | Every desktop command execution: the replayable `invocation`, `gitHead`, `gitDirty`, `written` paths, status, message. "What changed my files?" starts here. |
| `build/manifest.json` | Provenance for every generated asset: which task, which prompt hash, which references. |
| `work/` | The human-editable views (story graph, candidates, `approved.png`). If the gate seems stuck, check the character's front-matter status here. |

Task identity is `sha256(kind, inputs)` — so if work you expected to be reused is being
regenerated, something in its inputs (prompt, reference hashes, model id, params) changed.
Compare the task hashes in `tasks.jsonl` across the two runs to find which input moved.

Remember the planner is **incremental**: `vngen cost` and a `--mock` run only see
currently-plannable work, so "missing" downstream tasks right after a gate are normal —
they appear once upstream tasks are `done`.

## Reproducing offline

- `vngen run <dir> --mock` — plans and previews with zero API calls. If a bug reproduces
  under `--mock`, it's in the deterministic core and is unit-testable; if it doesn't,
  suspect a provider/backend.
- Text-step fallbacks mean the pipeline runs end-to-end with mock providers; tests inject
  `RecordedChatBackend` / `StubImageBackend` (`@vn/providers` `mock.ts`) to pin provider
  contracts without network.
- `vnauthor <dir> --mock` smoke-tests workspace/skill loading and the REPL with no key.
- Mock runs never produce image bytes — don't expect mock and real assets to mix in one
  project; a real run treats mock state as absent references, not corrupt ones.

## Debugging the desktop app

Start the dev loop; it wires up everything the rest of this section uses:

```sh
pnpm --filter @vn/desktop dev     # vite HMR + esbuild watch + electron, CDP on 9222
```

Renderer edits hot-reload; **main-process edits need an app restart**. `VN_PROJECT`,
`VN_MOCK`, `VN_DEV_PORT`, `VN_CDP_PORT` all pass through.

### Drive it from a terminal (CDP)

The dev loop always opens Chrome's remote-debugging port on `127.0.0.1:9222`, and
`scripts/vn-cdp.mjs` is the ergonomic client:

```sh
node scripts/vn-cdp.mjs "view.room(name=floor)"    # any command DSL string
node scripts/vn-cdp.mjs --catalog                  # the LIVE registry (never the file)
node scripts/vn-cdp.mjs --history 5                # last commands + git provenance
node scripts/vn-cdp.mjs --raw "<js expression>"    # evaluate anything in the renderer
```

This is the preferred way for an agent to poke the app: no screenshots, no window focus,
exit code reflects command failure. Commands executed this way are recorded in
`commands.jsonl` like any other — check `--history` when unsure what actually ran.

Two serialization rules for `--raw` (CDP uses `returnByValue`): the expression must
produce **plain JSON data** — end debug queries in `.explain()` / `.table()` / a string —
and live objects (`ResultSet`, DOM nodes, `Fragment.raw`) come back as useless `{}`.

### UI bugs: ask `window.__vnDebug`, not a screenshot

Dev builds install the 2D debug surface (`@vn/debug2d`) on the renderer's `window`. It
answers "what is actually on screen, in what order, and why" from captured ground truth:

```sh
node scripts/vn-cdp.mjs --raw "window.__vnDebug.explainPick(400, 300)"
node scripts/vn-cdp.mjs --raw "window.__vnDebug.at(400, 300).explain()"
node scripts/vn-cdp.mjs --raw "window.__vnDebug.at(400, 300).table()"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__vnDebug.owners())"
```

- **"Why did my click miss / hit the wrong thing?"** → `explainPick(x, y)`. It prints the
  winner and an ordered rejection log: `pick='none'`, `clipped away by <ancestor>`,
  `alpha 0 — but pick='auto'`, and the flagship `z-index N ignored — <ancestor>
  established a stacking context via <reason>`.
- **"What's on top here?"** → `at(x, y)` (pick geometry — what a click would do) or
  `at(x, y, { using: 'paint' })` (what's drawn, including `pointer-events: none` layers).
- **"What's in this region?"** → `inAABB(rect, { mode: 'intersect' | 'contain' | 'center' })`.
- Chain filters: `.byTag()`, `.byOwner().descendants()`, `.bySource()`, `.where(pred)`.

Honesty caveats, load-bearing when interpreting output: DOM frames are
`fidelity: 'sampled'` (anything that changed and reverted between captures is invisible),
`exactZ: false` (computed CSS 2.1 order, not observed paint), and a
`⚠ oracle disagreement` line means the computed stack and the browser's
`elementsFromPoint` disagree — treat *both* as suspects, typically stale capture vs. a
stacking-walk bug.

To reproduce a UI bug as a regression test: rebuild the offending stack as a synthetic
frame with `makeTestFrame()` + `staticSource()` from `@vn/debug2d`, and assert on
`.explain()` output — it is deterministic and fixed-precision precisely so it can be a
golden.

### DevTools

The Electron window is a Chromium window; `Ctrl+Shift+I` gives the console (where
`window.__vnDebug` and `window.vn` are available as live objects, no serialization
limits), element inspector, and React DevTools-style fiber poking. Use it when you need
interactivity; use CDP when you need reproducibility or you're an agent.

## Debugging tests

- Tests are transpiled by esbuild (`scripts/jest-esbuild.cjs`) — no type checking. A test
  can pass while `pnpm check` fails; run both.
- **jsdom has no layout engine** — every `getBoundingClientRect` is zero. Never try to
  unit-test `dom/snapshot.ts` / `dom/source.ts` in `@vn/debug2d` or anything else that
  needs real layout; that's what the live CDP checks are for. The pure cores (stacking,
  pick, attribution, queries) take snapshot data and are fully testable.
- Golden-string failures in `@vn/debug2d` mean the *format* changed. That friction is
  intended: either fix the regression or edit the golden deliberately.
- Provider-shaped bugs: reproduce with `RecordedChatBackend` fixtures rather than hitting
  the network in a loop.

## Known traps

- **`contextBridge` deep-clones.** Anything exposed via preload loses function identity
  and cannot carry DOM nodes or fibers — which is why `window.__vnDebug` is installed by
  renderer code, not preload. Don't "fix" that by moving it.
- **Windows file locking.** Manifest writes are serialized through a single-writer queue
  because parallel atomic renames race on Windows. If you see rename/EPERM flakes in new
  code, you probably bypassed an existing single-writer path.
- **Secrets never appear in logs** by design. A key-resolution error names the *source*
  (env var / file path), not the value. Don't add logging that changes this while
  debugging key problems — test resolution with a throwaway key instead.
- **`turbo` caching.** If a bundle looks stale despite a source edit, remember internal
  packages have no build step — cache invalidation rides on `turbo.json`'s
  `globalDependencies` globs. `pnpm build --force` bypasses the cache while you check.
- **Two command catalogs.** `apps/desktop/dist/commands.json` is a build artifact;
  the `command:catalog` IPC channel serves the live registry. When they disagree, the file
  is stale — rebuild; never debug against the file.
