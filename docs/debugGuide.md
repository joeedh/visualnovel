# Debugging guide

<!-- toc -->

- [First: the gates](#first-the-gates)
- [Reading the evidence on disk](#reading-the-evidence-on-disk)
- [Reproducing offline](#reproducing-offline)
  * [Getting a project into the state you need](#getting-a-project-into-the-state-you-need)
- [Debugging the desktop app](#debugging-the-desktop-app)
  * [Is the running app your app?](#is-the-running-app-your-app)
  * [Drive it from a terminal (CDP)](#drive-it-from-a-terminal-cdp)
  * [Synthetic input](#synthetic-input)
  * [A whole surface at once: a scripted PASS/FAIL run](#a-whole-surface-at-once-a-scripted-passfail-run)
  * [UI bugs: ask `window.__vnDebug`, not a screenshot](#ui-bugs-ask-window__vndebug-not-a-screenshot)
  * [CSS: silent failures and cascade order](#css-silent-failures-and-cascade-order)
  * [DevTools](#devtools)
- [Debugging tests](#debugging-tests)
- [Known traps](#known-traps)

<!-- tocstop -->

How to debug this repo, written for whoever (or whatever) is doing the debugging — the
sections are ordered from cheapest tool to most expensive, and the recurring theme is:
**prefer ground truth (logs, state files, query output) over reproduction and screenshots.**
Most of the system was designed to leave evidence behind; start by reading it.

Almost everything below is here because it cost someone an hour first. Where a lesson has a
symptom, the symptom is written down — it is the part you will recognize before you recognize
the cause.

## First: the gates

Before debugging anything subtle, make sure the boring failures aren't the problem:

```sh
pnpm check                                    # tsgo over the workspace AND the renderer
pnpm exec jest --selectProjects @vn/store     # one package's suite, fast
pnpm test                                     # everything
pnpm lint                                     # eslint (boundaries!) + prettier check
```

Things the gates catch that look like deep bugs but aren't:

- **A cross-layer import.** The boundaries rule rejects it — but note the historical
  gotcha: an *unresolved* import is an *unclassified* one, which the rule silently passes.
  If a boundaries violation you expected doesn't fire, suspect resolution (the TypeScript
  resolver in `eslint.config.mjs`), not the rule.
- **Renderer type errors.** `pnpm check` is **two passes** — the root `tsconfig.json` covers
  `*/src/**` only, and `pnpm check:renderer` covers `apps/desktop/renderer/**`. Running
  `tsgo -p tsconfig.json` by hand checks half the repo and looks green.
- **A missing workspace link** after adding a package — run `pnpm install` (a new
  `package.json` does not create its `node_modules` link, and the symptom is
  `Cannot find module 'yaml'` in the new package only, which reads as a `paths` problem and
  isn't). Remember the four lists that must all know a new package: root `tsconfig.json`
  `paths`, `jest.config.cjs` `PACKAGES`, `scripts/aliases.mjs` `PACKAGES`,
  `eslint.config.mjs` — plus `apps/desktop/renderer/tsconfig.json` if the renderer imports it.

**A suite failing in a file your diff never touched** is usually a generated artifact, not
your change. The desktop project compares `apps/desktop/dist/commands.json` — a gitignored
build output, so `git status` shows nothing and a fresh `pnpm test` reproduces it forever —
against the live registry. Rebuild before reading any source:

```sh
node scripts/gen-command-catalog.mjs   # "commands.json: 26 command(s)" — green again
```

**A gate that passes on its first run has not been shown to work.** A `tsconfig` whose
`include` matches nothing, or a `-p` pointed at a missing file, also exits 0. Break it on
purpose once, then revert:

```sh
echo 'const _deliberate: number = "not a number";' >> apps/desktop/renderer/main.tsx
pnpm check          # expect TS2322 and exit 1
git checkout apps/desktop/renderer/main.tsx
```

Same reasoning as a test you have never seen fail: it is not yet evidence.

## Reading the evidence on disk

A `vngen` project leaves a complete audit trail under `<project>/vngen/`. When a run "did
something weird", the answer is usually already written down:

| File | What it tells you |
| ---- | ----------------- |
| `state/tasks.jsonl` | Every task status transition, append-only. Replaying it (last writer wins per task hash) *is* the graph state — if a run resumed strangely, diff what you expected against what's here. |
| `state/commands.jsonl` | Every desktop command execution: the replayable `invocation`, `gitHead`, `gitDirty`, `written` paths, status, message. "What changed my files?" starts here. |
| `build/manifest.json` | Provenance for every generated asset: which task, which prompt hash, which references. |
| `work/` | The human-editable views (story graph, candidates, `approved.png`, `shots/<sceneId>.json`). If the gate seems stuck, check the character's front-matter status here. |

Task identity is `sha256(kind, inputs)` — so if work you expected to be reused is being
regenerated, something in its inputs (prompt, reference hashes, model id, params) changed.
Compare the task hashes in `tasks.jsonl` across the two runs to find which input moved.

Remember the planner is **incremental**: `vngen cost` and a `--mock` run only see
currently-plannable work, so "missing" downstream tasks right after a gate are normal —
they appear once upstream tasks are `done`.

**When a hand-edit to one of these files does nothing, check that the consumer reads it at
all before re-checking the edit.** `work/shots/<sceneId>.json` is the documented free repair
for coverage, and for a while editing it changed nothing because `buildPlayable` consulted
`scene.shots` — empty on a model rebuilt from disk — and reconstructed a deterministic
baseline naming shot ids no run had produced. The evidence was a throwaway script calling
`buildPlayable` directly and counting `show` beats with and without an image; the file edit
had been correct all along. Two independent faults were stacked, and either one alone blanks
the scene, so fixing one leaves the symptom identical.

**Run `git status` at the end of a live session, not just at the end of the code.** Every
command executed over CDP appends a `CommandRecord` to `commands.jsonl` in whatever workspace
the app was pointed at — including a committed tree like `examples/sample`, where generated
provenance does not belong.

## Reproducing offline

- `vngen run <dir> --mock` — plans and previews with zero API calls. If a bug reproduces
  under `--mock`, it's in the deterministic core and is unit-testable; if it doesn't,
  suspect a provider/backend.
- Text-step fallbacks mean the pipeline runs end-to-end with mock providers; tests inject
  `RecordedChatBackend` / `StubImageBackend` (`@vn/providers` `mock.ts`) to pin provider
  contracts without network.
- `vnauthor <dir> --mock` smoke-tests workspace/skill loading and the REPL with no key.
- **`--mock` writes no assets, but mock providers used directly do.** `StubImageBackend`
  emits real placeholder PNGs carrying a `vn-mock-placeholder` `tEXt` chunk, and the Gemini
  backend's `imagePart` refuses any reference carrying it. That marker is what keeps mock
  bytes out of a real run — magic-byte sniffing can't, because a placeholder decodes fine.

### Getting a project into the state you need

- **The desktop app cannot produce tasks in mock mode.** `session.ts` passes `mock` straight
  through as `dryRun`, so `pipeline.run(mock=true)` reports `ran 0 tasks` and the graph shows a
  gate barrier, unplanned slots, and nothing real. The command's own result says so; believe it before
  suspecting the derivation. On-disk task state comes from `@vn/testkit` — a throwaway jest
  test that builds `makeProject` fixtures and prints their paths (one gate-halted, one through
  `approveAll()`), then `$env:VN_PROJECT=<dir>` before the dev loop. **Never** point a run at
  `examples/sample` to get tasks: its committed `vngen/` tree is authored output, and
  fabricated provenance there is worse than no fixture.
- **A UI for a rare state is unfalsifiable until you can produce the state.** The refine-loop
  inspector renders multi-attempt `shot_image` tasks and no ordinary run produces one. Both
  obvious shortcuts fail: a hand-written `tasks.jsonl` can fabricate attempts but not the
  bytes their thumbnails resolve from, and a real run can't be made to block on demand. What
  worked was the real `runPipeline` with two scripted backends — real PNG bytes, plus a
  reviewer that blocks the first N attempts of chosen shots. When a display targets a state
  the app rarely reaches, the fixture is the hard part and it comes first.
- **Verify a degraded state by building one, not by assuming it.** "A project with no assets
  will show empty thumbnails" is a prediction; whether it shows *nothing* or a broken-image
  icon is the actual question. Empty `build/assets/`, reduce the manifest, then count:

  ```sh
  node scripts/vn-cdp.mjs --raw "JSON.stringify({imgs: document.querySelectorAll('.att-shot img').length, none: document.querySelectorAll('.att-shot.none').length})"
  # {"imgs":0,"none":3}  — placeholders, and no <img> emitted at all
  ```

  Trap: `manifest.json` is `{"version":1,"assets":[…]}`, not a bare array. Writing `[]` gives
  you a manifest that fails to *parse*, and the app degrades down a different path than the
  one you meant to test.

## Debugging the desktop app

Start the dev loop; it wires up everything the rest of this section uses:

```sh
pnpm --filter @vn/desktop dev     # vite HMR + esbuild watch + electron, CDP on 9222
```

Renderer edits hot-reload; **main-process edits need an app restart**. `--mock`/`--project
<dir>` (or their `VN_MOCK=1`/`VN_PROJECT=<dir>` env fallbacks) and `VN_DEV_PORT`, `VN_CDP_PORT`
all pass through — the dev loop runs for real by default, same as a packaged build, so add
`--mock` when you don't want live model calls.

To drive the **built** app instead — a main-process bug, a bundling question, anything where
Vite's copy is the wrong thing to look at — `pnpm build:desktop && pnpm vndesktop` opens 9222
too. `pnpm --filter @vn/desktop start` is the same app with no port, so an app you can't reach
over CDP was probably started that way.

### Is the running app your app?

Two rounds of "the pointerdown isn't reaching the renderer" were once spent on an app started
with `pnpm --filter @vn/desktop start`, which serves the **built** renderer — every source edit
was invisible. The symptom to recognize: **a fix that changes behaviour not at all, twice, with
no error.** Before diagnosing further, confirm the running app contains the change.

The same symptom comes from a stale Electron holding CDP 9222 from a previous session, in
which case you are driving an app you didn't start — and now that `pnpm vndesktop` opens the
same port, the stale one is as likely to be a built app as a dev loop. Killing either from
outside is not Ctrl-C, so its tree survives:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dev.desktop.mjs*' -or $_.CommandLine -like '*vndesktop.mjs*' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F }

# or, by the ports themselves (5176 = Vite, 9222 = CDP):
Get-NetTCPConnection -LocalPort 9222,5176 -State Listen | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $($_.OwningProcess)" | Stop-Process -Force
  Stop-Process -Id $_.OwningProcess -Force
}
```

`/T` matters — esbuild, Vite and Electron are children, and killing only the parent leaves the
ports held. Re-query the ports afterwards to confirm they're released. Don't blanket-kill
`electron.exe`; on a dev machine some of those belong to the user's editor.

### Drive it from a terminal (CDP)

The dev loop always opens Chrome's remote-debugging port on `127.0.0.1:9222`, and
`scripts/vn-cdp.mjs` is the ergonomic client:

```sh
node scripts/vn-cdp.mjs "view.open(editor=timeline)"  # any command DSL string
node scripts/vn-cdp.mjs --catalog                  # the LIVE registry (never the file)
node scripts/vn-cdp.mjs --history 5                # last commands + git provenance
node scripts/vn-cdp.mjs --raw "<js expression>"    # evaluate anything in the renderer
```

This is the preferred way for an agent to poke the app: no screenshots, no window focus,
exit code reflects command failure. Commands executed this way are recorded in
`commands.jsonl` like any other — check `--history` when unsure what actually ran.

**Ask before you act.** A mutating command's refusal is reachable without running it, so a
diagnosis costs nothing and writes nothing:

```sh
node scripts/vn-cdp.mjs --raw "window.vn.check('story.setNext', {scene: 'arrival'}).then(r => (window.__x = r)) && 'ok'"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__x)"
#  {"state":"refuse","message":"arrival has no next scene to clear."}
```

`state` is three-valued: `undeclared` means the command states no precondition, **not** that it
would succeed. The DSL form (`command.check(invocation="…")`) nests quotes two deep, which
PowerShell mangles — use `window.vn.check` with an id and props from PowerShell, or run the DSL
form from a POSIX shell.

Four rules for `--raw`, each of which produces a misleading failure when broken:

- **Return plain JSON data** (CDP uses `returnByValue`). End debug queries in `.explain()` /
  `.table()` / a string; live objects (`ResultSet`, DOM nodes, `Fragment.raw`) come back as
  useless `{}`.
- **No `await`** — the expression's promise is GC'd first and you get `Error: Promise was
  collected`. Stash on a global, then read it in a second call:

  ```sh
  node scripts/vn-cdp.mjs --raw "window.vn.exec(\"pipeline.status()\").then(r => (window.__x = r)) && 'started'"
  node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__x).slice(0, 400)"
  ```

- **From PowerShell, quote double-outside / single-inside.** PowerShell strips inner double
  quotes when passing arguments to a native exe, so
  `--raw "document.querySelectorAll(".tg-node").length"` arrives as
  `document.querySelectorAll(.tg-node).length` — a syntax error, which CDP reports as a bare
  `Uncaught` with no message. Worth recognizing on sight; the error text points nowhere.
- **Never dispatch and assert in one evaluation.** React re-renders after the current task, so
  the read runs against pre-event state and returns `undefined` — which reads as "the
  interaction never happened" when it did. Split them.

### Synthetic input

Simulating a gesture takes **one evaluation per event**, for the reason above plus one more:
window-level `pointermove`/`pointerup` listeners are installed by an effect *after* the render
that begins a drag, so a `down` and a `move` in the same evaluation reach no listener at all.

```sh
node scripts/vn-cdp.mjs --raw "window.__drag.down(window.__drag.handleAt('ending')),'down'"
node scripts/vn-cdp.mjs --raw "window.__drag.move(window.__drag.centerAt('arrival')),'move'"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__drag.state())"
```

The helper worth writing first is `state()` — one object with the status line, the per-element
verdict classes, and whether the transient elements exist. Every assertion becomes a diff of
that object, which is how two real bugs surfaced that a screenshot would not have shown.

- **Dispatch on the surface, not the node.** `document.querySelector('.tg-node').click()`
  selects nothing and raises no error: the node layer is `pointer-events: none` (`Canvas.tsx`)
  because `pick` is meant to be the single answer to "what is under the cursor". Take the
  geometry from the node's client rect and send a real `PointerEvent` to `.graph-canvas`.
- **Confirm the pointer is where you think before blaming a hit test.** An SVG path's own
  midpoint (`getPointAtLength(getTotalLength()/2)`, mapped through `getScreenCTM`) is ground
  truth; comparing it to the world point the app computed eliminated the entire coordinate
  pipeline in one call and left only the handler, where the bug was.
- **Hit-testing under a drag needs somewhere to land.** If you resolve "what row/cell is the
  pointer over" with `elementFromPoint`, remember that during a drag the thing under the
  cursor is usually the element being dragged. The fix is structural, not a special case: a
  full-width hit band per row behind everything, plus a `dragging` class that drops pointer
  events on the layers above it (`renderer/styles/timeline.css`). Assert the band rects
  against the dragged element's rect *before* simulating anything — geometry first, then
  events.

### A whole surface at once: a scripted PASS/FAIL run

`scripts/cdp.mjs` is the wire on its own — `connect`, `pageTarget`, `send`, `evaluate`, `exec` —
so a script that has to do more than one thing holds a single socket instead of paying `--raw`'s
connect-per-call. `scripts/verify-prompt-chunks.mjs` is the worked example: it drives the asset
pane's prompt editor through ten steps and prints a PASS/FAIL line each. Four things it had to
learn, all of which cost a debugging cycle first:

- **`window.vn.exec` goes preload → main**, so it never passes through the renderer's `bridge.exec`
  and the pane's `onInvalidate` does not fire. A command driven from a script therefore leaves the
  surface stale; the script re-reads it the way a click would, by retoggling the subject — and it
  must retoggle through a **different** subject, because `applyView` ignores an empty one.
- **The editors' shadow roots are open, but `document.querySelectorAll` still does not cross
  them.** Walk: for every element, recurse into `.shadowRoot` if it has one. A selector that
  silently matches nothing reads exactly like a feature that did not happen.
- **`Input.dispatchMouseEvent` is a real pointer**, with a valid `pointerId`, so
  `setPointerCapture` works and a drag can be exercised end to end — down, move, assert nothing
  moved yet, up. Synthetic `PointerEvent`s dispatched from JS do not capture.
- **Poll, never sleep.** Every read after a command is a loop with a deadline: the surface settles
  a beat behind the store, and a fixed `sleep` that passes on a warm machine fails on a cold one.

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
- **"Did this room mount anything at all?"** → `capture().fragments.length`. Note `capture()`
  returns a **frame** (`{index, t, fragments, spaces, caps, fidelity, oracle}`), not an array;
  `capture().length` is `undefined`, which reads as a broken debug layer rather than a wrong
  property.
- Chain filters: `.byTag()`, `.byOwner().descendants()`, `.bySource()`, `.where(pred)`.

**Before believing an empty result, ask the engine what ids exist.** `byOwner` is an exact
match on `f.owner.id`, and fiber-derived ids are `Component/label` — `AttemptLoop/div.loop`,
never bare `AttemptLoop`. An empty result from a query engine reads as "the thing isn't
there", which is the worst possible failure mode for a debug tool: it sends you to the
renderer. `owners()` is one call and settles it; `where(f => f.owner.id.startsWith(…))` is the
prefix form. (`owners()` returns objects, so it stringifies to `[object Object]` in a joined
expression — take the fields you want, or end in `.table()`.)

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

### CSS: silent failures and cascade order

- **An invalid CSS transform is dropped without a word** — no console warning, no exception,
  no DevTools strike-through — and the layer just sits at world coordinates. The branch editor
  once rendered every card piled at the canvas's left edge while the wires were placed
  correctly, which read as broken pointer events. Reading *both* layers' transforms out of the
  DOM was the whole diagnosis:

  ```sh
  node scripts/vn-cdp.mjs --raw "JSON.stringify({svg: document.querySelector('.graph-wires g').getAttribute('transform'), html: document.querySelector('.graph-layer').style.transform})"
  # {"svg":"translate(567.1953125 48) scale(0.664)","html":""}
  ```

  The SVG form `translate(x y)` is not valid CSS (which needs `translate(3px, 4px)`), hence
  `transformOf` vs. `cssTransformOf`. Generally: **treat "assigned a style, read it back
  empty" as a parse failure, not a stale render**, and when a co-transformed pair disagrees,
  read both before touching the geometry.
- **Ordering questions go to the CSSOM, not the window.** `styles/index.css` import order *is*
  cascade order, and `@media` blocks add no specificity — a breakpoint that ends up before the
  base rule it narrows silently stops applying, at one window size only. Computed style proves
  the base rule; only rule order proves the override:

  ```sh
  node scripts/vn-cdp.mjs --raw "(()=>{const h=[];[...document.styleSheets].forEach((ss,si)=>{let r;try{r=[...ss.cssRules]}catch(e){return}r.forEach((x,i)=>{if(/\.studio[{ >,]/.test(x.cssText))h.push(si+'.'+i)})});return h.join(',')})()"
  # 1.53 (base), 1.104 (@media override) — same sheet, override last. Correct.
  ```

  Check it live as well as in `vite build` output: dev resolves `@import` into injected
  `<style>` elements, so a dev-only ordering bug is possible. A screenshot catches none of
  this, and neither does eyeballing the app at one width.

### DevTools

The Electron window is a Chromium window; `Ctrl+Shift+I` gives the console (where
`window.__vnDebug` and `window.vn` are available as live objects, no serialization
limits), element inspector, and React DevTools-style fiber poking. Use it when you need
interactivity; use CDP when you need reproducibility or you're an agent.

## Debugging tests

- **Tests are transpiled by esbuild** (`scripts/jest-esbuild.cjs`) — no type checking. A test
  file can be jest-green and committed for a session with a real type error in it. `pnpm test`
  is not evidence that test code typechecks; only `pnpm check` is, and it does cover `tests/`.
- **`Task<K>` is generic, so `kind` does not narrow `inputs`.**
  `tasks.filter(t => t.kind === 'shot_image').map(t => t.inputs.shotId)` fails to compile,
  because `Task<K extends TaskKind>` (`packages/types/src/tasks.ts`) is a generic interface,
  not a discriminated union — an `AnyTask` has `inputs: TaskInputs[TaskKind]`, which a `kind`
  comparison cannot narrow. In tests the cast is the idiom
  (`t.inputs as TaskInputs['shot_image']`); in product code prefer narrowing on the shape
  (`if ('shotId' in inputs)`), which is a real narrowing rather than an assertion.
- **The gate is per scene, so "no shots ran" is the wrong assertion.** `planTasks` unblocks
  shots per scene, and a scene with no cast renders on the *first* run, before any approval —
  an assertion that held only because a hand-built fixture had one scene. Assert on
  `summary.blockedOnGate`, `summary.gate.pending`, or the specific shot ids that must not
  appear:

  ```ts
  expect(first.gate.pending).toEqual(['aiko', 'haruki']);
  expect(shotIds(first.ran)).not.toContain('arrival__establishing');
  ```

- **When a filter matches nothing, print the value it filtered on** before questioning the
  machinery around it. A scripted reviewer once matched no shots because `ShotSpec.location`
  is a **variant id** (`'day'`), not a location name — two `string`s, so no type catches it.
  Parse structured output (`JSON.parse`) rather than regexing it; the regex "worked" by
  matching a different field and hid the mismatch.
- **jsdom has no layout engine** — every `getBoundingClientRect` is zero. Never try to
  unit-test `dom/snapshot.ts` / `dom/source.ts` in `@vn/debug2d` or anything else that
  needs real layout; that's what the live CDP checks are for. The pure cores (stacking,
  pick, attribution, queries) take snapshot data and are fully testable. Same split in the
  renderer: `.ts` with a `tests/` sibling is tested, `.tsx` is not.
- **A `*.test.ts` outside a `tests/` folder is silently never run** — every project's
  `testMatch` requires the directory. A suite that "passes" without appearing in the output
  isn't passing.
- Golden-string failures in `@vn/debug2d` mean the *format* changed. That friction is
  intended: either fix the regression or edit the golden deliberately.
- Provider-shaped bugs: reproduce with `RecordedChatBackend` fixtures rather than hitting
  the network in a loop.
- **`git diff --no-index` verifies a fixture that isn't a repo.** A scratchpad copy of
  `examples/sample` can still answer "did the editor change only branch markers", and an
  empty diff after an unwire-then-rewire is a stronger round-trip test than anything available
  from inside the app:

  ```sh
  git diff --no-index -- examples/sample/scenes "$SCRATCH/branchdemo/scenes"
  ```

- **Windows, if you build a git-backed temp dir by hand** (`@vn/testkit`'s `initRepo` already
  does all three): set repo-local `user.email`/`user.name`, or `git commit` fails outright on
  a clean box; set `core.autocrlf false`, or a diff assertion compares different line endings
  than the bytes the test wrote; and remove with
  `rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`, because git
  leaves read-only pack files Windows may refuse to unlink first time.

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
