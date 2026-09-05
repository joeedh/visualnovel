# Debugging guide

<!-- toc -->

- [First: the gates](#first-the-gates)
- [Reading the evidence on disk](#reading-the-evidence-on-disk)
    - [The request a model refused](#the-request-a-model-refused)
- [Reproducing offline](#reproducing-offline)
    - [Getting a project into the state you need](#getting-a-project-into-the-state-you-need)
- [Debugging the desktop app](#debugging-the-desktop-app)
    - [Is the running app your app?](#is-the-running-app-your-app)
    - [Drive it from a terminal (CDP)](#drive-it-from-a-terminal-cdp)
    - [Synthetic input](#synthetic-input)
    - [A whole surface at once: a scripted PASS/FAIL run](#a-whole-surface-at-once-a-scripted-passfail-run)
    - [UI bugs: ask `window.__vnDebug`, not a screenshot](#ui-bugs-ask-window__vndebug-not-a-screenshot)
    - [CSS: silent failures and cascade order](#css-silent-failures-and-cascade-order)
    - [DevTools](#devtools)
- [Debugging tests](#debugging-tests)
- [Known traps](#known-traps)

<!-- tocstop -->

How to debug this repo, written for whoever (or whatever) is doing the debugging. The
sections are ordered from cheapest tool to most expensive. Prefer ground truth (logs,
state files, query output) over reproduction and screenshots. Most of the system was
designed to leave evidence behind, so start by reading it.

Almost everything below is here because it cost someone an hour first. Each lesson that
has a symptom records that symptom, because a reader recognizes the symptom before the
cause.

## First: the gates

Rule out the common failures before debugging a subtle problem:

```sh
pnpm check                                    # tsgo over the workspace AND the renderer
pnpm exec jest --selectProjects @vn/store     # one package's suite, fast
pnpm test                                     # everything
pnpm lint                                     # eslint (boundaries!) + prettier check
```

The gates catch these cases, which look like deep bugs but are not:

- **A cross-layer import.** The boundaries rule rejects it. Note the historical gotcha:
  the rule cannot classify an import it fails to resolve, and passes it. If a boundaries
  violation you expected is missing, suspect resolution (the TypeScript resolver in
  `eslint.config.mjs`) rather than the rule.
- **Renderer type errors.** `pnpm check` runs two passes: the root `tsconfig.json` covers
  `*/src/**` only, and `pnpm check:renderer` covers `apps/desktop/renderer/**`. Running
  `tsgo -p tsconfig.json` by hand checks half the repo and reports success.
- **A missing workspace link** after adding a package — run `pnpm install`. A new
  `package.json` does not create its `node_modules` link, and the symptom is
  `Cannot find module 'yaml'` in the new package only, which looks like a `paths` problem
  but is not. Four lists must all name a new package: root `tsconfig.json` `paths`,
  `jest.config.cjs` `PACKAGES`, `scripts/aliases.mjs` `PACKAGES`, and `eslint.config.mjs`.
  Add `apps/desktop/renderer/tsconfig.json` as well if the renderer imports it.

A suite that fails in a file your diff never touched is usually a generated artifact
rather than your change. The desktop project compares `apps/desktop/dist/commands.json` (a
gitignored build output, so `git status` shows nothing and a fresh `pnpm test` reproduces
it forever) against the live registry. Rebuild before reading any source:

```sh
node scripts/gen-command-catalog.mjs   # "commands.json: 26 command(s)" — green again
```

A gate that passes on its first run is unproven. A `tsconfig` whose `include` matches
nothing (or a `-p` pointed at a missing file) also exits 0. Break it on purpose once, then
revert:

```sh
echo 'const _deliberate: number = "not a number";' >> apps/desktop/renderer/main.tsx
pnpm check          # expect TS2322 and exit 1
git checkout apps/desktop/renderer/main.tsx
```

The same reasoning applies to a test you have never seen fail. Such a test is not yet
evidence.

## Reading the evidence on disk

A `vngen` project keeps a complete audit trail under `<project>/vngen/`. When a run
behaves unexpectedly, that trail usually already records the cause:

| File                   | What it tells you                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/tasks.jsonl`    | Every task status transition, append-only. Replaying it (last writer wins per task hash) _is_ the graph state — if a run resumed strangely, diff what you expected against what's here. |
| `state/commands.jsonl` | Every desktop command execution: the replayable `invocation`, `gitHead`, `gitDirty`, `written` paths, status, message. "What changed my files?" starts here.                            |
| `build/manifest.json`  | Provenance for every generated asset: which task, which prompt hash, which references.                                                                                                  |
| `work/`                | The human-editable views (story graph, candidates, `approved.png`, `shots/<sceneId>.json`). If the gate seems stuck, check the character's front-matter status here.                    |

Each task is identified by `sha256(kind, inputs)`. Work you expected to be reused is
regenerated when one of its inputs (prompt, reference hashes, model id, params) has
changed. Compare the task hashes in `tasks.jsonl` across the two runs to find which input
moved.

The planner is incremental. `vngen cost` and a `--mock` run only see currently-plannable
work, so downstream tasks that look missing right after a gate are normal. Those tasks
appear once the upstream tasks are `done`.

When a hand-edit to one of these files does nothing, check that the consumer reads it at
all before re-checking the edit. `work/shots/<sceneId>.json` is the documented free repair
for coverage, and for a while editing it changed nothing because `buildPlayable` consulted
`scene.shots` (empty on a model rebuilt from disk) and reconstructed a deterministic
baseline naming shot ids no run had produced. A throwaway script called `buildPlayable`
directly and counted `show` beats with and without an image, which showed the file edit
had been correct all along. Two independent faults were stacked, and either one alone
blanks the scene, so fixing one leaves the symptom identical.

**Run `git status` at the end of a live session, not only at the end of a coding
session.** Every command executed over CDP appends a `CommandRecord` to `commands.jsonl`
in whatever workspace the app was pointed at. That workspace can be a committed tree such
as `templates/basic`, where generated provenance does not belong.

### The request a model refused

A conversation request is the one body in this repo that is assembled rather than written
out at the call site: `buildConvoRequest` folds the system prompt, the tool catalog and
the whole transcript together, sends the result, and keeps no copy. So a 400 that names a
position — "messages.1.content.0: unexpected `tool_use_id` found in
`tool_search_tool_result` blocks" — is unreadable, because the request that the position
indexes into no longer exists.

`packages/providers/src/backends/capture.ts` keeps it. It goes to two destinations that
are deliberately unlike each other.

The ring lives in memory and is always on. Every Anthropic and Gemini call site captures
its vendor body before sending it — `claude`, `claude-tools`, `convo`, `gemini`,
`gemini-tools` — and records the failure beside it afterwards. The ring is bounded by
bytes and by count, evicting the oldest entry first, and defaults to 64 MB / 64 entries
(`VN_CAPTURE_BYTES`, `VN_CAPTURE_COUNT`). A body larger than the whole byte cap is
discarded, and its header is kept and marked `dropped`, which records that a request of
that size was sent.

The ring is never sent anywhere. Its one reader is the debug report agent, which runs on
the author's own key and only when they tick "Read the requests this session sent". The
app ticks that box for them when it offers to look into an API refusal. That agent reads
structure and capped, redacted values, and none of it reaches the report: nothing goes
past the author's own model provider. See
[`../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it`](../plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it).

**Request bodies are written to disk when `VN_DUMP_REQUESTS` names a directory, and are
off otherwise.** Each body is written as `<label>-<pid>-<seq>.json`, with a `.error.txt`
beside the ones that failed. Dumping is deliberately not tied to a log level, because the
body carries the author's whole conversation and whatever file contents the agent had
read, so turning it on is a decision rather than a side effect of asking for more logs.
The body never contains the API key, which is set on the client rather than in the
payload.

```powershell
$env:VN_DUMP_REQUESTS = "C:\dev\vn-requests"
pnpm --filter @vn/desktop build   # the launcher runs the built app; it does not build
pnpm vndesktop
```

Both are written before the call, because a call that never returns is still a failure
worth capturing.

There are two ways to end up with nothing. `--mock` makes no provider calls at all, and a
stale `dist/` holds none of this, because `@vn/providers` is source-only and is bundled
into the desktop's main bundle. Expect one entry per step rather than per turn — a turn
that calls four tools captures four bodies.

## Reproducing offline

- `vngen run <dir> --mock` — plans and previews with zero API calls. A bug that reproduces
  under `--mock` is in the deterministic core and is unit-testable. A bug that does not
  reproduce under `--mock` is likely in a provider or a backend.
- Text-step fallbacks let the pipeline run end-to-end with mock providers. Tests inject
  `RecordedChatBackend` / `StubImageBackend` (`@vn/providers` `mock.ts`) to pin provider
  contracts without network.
- `vnauthor <dir> --mock` smoke-tests workspace/skill loading and the REPL with no key.
- **`--mock` writes no assets, but a mock provider used directly writes them.**
  `StubImageBackend` emits real placeholder PNGs carrying a `vn-mock-placeholder` `tEXt`
  chunk, and the Gemini backend's `imagePart` refuses any reference carrying that chunk.
  The marker keeps mock bytes out of a real run. Magic-byte sniffing cannot keep them out,
  because a placeholder decodes fine.

### Getting a project into the state you need

- **The desktop app cannot produce tasks in mock mode.** `session.ts` passes `mock`
  straight through as `dryRun`, so `pipeline.run(mock=true)` reports `ran 0 tasks` and the
  graph shows a gate barrier, unplanned slots, and no real tasks. The command reports this
  result, so read it before suspecting the derivation. On-disk task state comes from
  `@vn/testkit`. Write a throwaway jest test that builds `makeProject` fixtures and prints
  their paths (one gate-halted, one through `approveAll()`), then set
  `$env:VN_PROJECT=<dir>` before the dev loop. Never point a run at `templates/basic` to
  get tasks: its committed `vngen/` tree is authored output, and fabricated provenance
  there is worse than no fixture.
- **A UI for a rare state cannot be tested until you can produce that state.** The
  refine-loop inspector renders multi-attempt `shot_image` tasks and no ordinary run
  produces one. Both obvious shortcuts fail. A hand-written `tasks.jsonl` can fabricate
  attempts but not the bytes their thumbnails resolve from, and a real run cannot be made
  to block on demand. The real `runPipeline` with two scripted backends worked: one
  supplies real PNG bytes, the other is a reviewer that blocks the first N attempts of
  chosen shots. When a display targets a state the app rarely reaches, building the
  fixture takes most of the work and has to come first.
- **Verify a degraded state by building one, not by assuming it.** The claim "a project
  with no assets will show empty thumbnails" predicts a result rather than observing one,
  and the real question is whether it shows nothing or a broken-image icon. Empty
  `build/assets/`, reduce the manifest, then count:

    ```sh
    node scripts/vn-cdp.mjs --raw "JSON.stringify({imgs: document.querySelectorAll('.att-shot img').length, none: document.querySelectorAll('.att-shot.none').length})"
    # {"imgs":0,"none":3}  — placeholders, and no <img> emitted at all
    ```

    Beware that `manifest.json` is `{"version":1,"assets":[…]}`, not a bare array. Writing
    `[]` gives you a manifest that fails to parse, and the app degrades down a different
    path than the one you meant to test.

## Debugging the desktop app

Start the dev loop. The dev loop wires up everything the rest of this section uses:

```sh
pnpm --filter @vn/desktop dev     # vite HMR + esbuild watch + electron, CDP on 9222
```

Renderer edits hot-reload. Main-process edits need an app restart.
`--mock`/`--project <dir>` (or their `VN_MOCK=1`/`VN_PROJECT=<dir>` env fallbacks),
`VN_DEV_PORT` and `VN_CDP_PORT` all pass through. The dev loop makes live model calls by
default, the same as a packaged build, so add `--mock` when you do not want them.

`pnpm build:desktop && pnpm vndesktop` drives the built app and opens 9222 too. Use it for
a main-process bug, a bundling question, or anything where Vite's copy is the wrong thing
to look at. `pnpm --filter @vn/desktop start` runs the same app with no port, so an app
you cannot reach over CDP was probably started that way.

### Is the running app your app?

Two rounds of "the pointerdown isn't reaching the renderer" were once spent on an app
started with `pnpm --filter @vn/desktop start`, which serves the built renderer, so every
source edit was invisible. The symptom is a fix that changes behaviour not at all, twice,
with no error. Confirm that the running app contains the change before diagnosing further.

A stale Electron holding CDP 9222 from a previous session produces the same symptom, and
you are then driving an app you did not start. Now that `pnpm vndesktop` opens the same
port, the stale process is as likely to be a built app as a dev loop. Killing either from
outside is not the same as Ctrl-C, so the process tree survives:

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

`/T` matters because esbuild, Vite and Electron are child processes, and killing only the
parent leaves the ports held. Re-query the ports afterwards to confirm they are released.
Do not blanket-kill `electron.exe`; on a dev machine some `electron.exe` processes belong
to the user's editor.

### Drive it from a terminal (CDP)

The dev loop always opens Chrome's remote-debugging port on `127.0.0.1`, and
`scripts/vn-cdp.mjs` provides an ergonomic client for it:

```sh
node scripts/vn-cdp.mjs "view.open(editor=timeline)"  # any command DSL string
node scripts/vn-cdp.mjs --catalog                  # the LIVE registry (never the file)
node scripts/vn-cdp.mjs --history 5                # last commands + git provenance
node scripts/vn-cdp.mjs --raw "<js expression>"    # evaluate anything in the renderer
node scripts/vn-cdp.mjs --window 1 --raw "location.search"   # the second window
```

**Which port, and which window.** `scripts/vndesktop.mjs` probes 9222–9241 and takes the
first free one, so `9222` is only the first choice and a second instance on a second
project does not answer on the first one's port. It prints the port it took as a
ready-to-paste `VN_CDP_PORT=<n> node scripts/vn-cdp.mjs …` line. Read that line rather
than assuming which port is in use. Setting `VN_CDP_PORT` yourself is honoured verbatim,
including an empty value (which turns CDP off).

A running app can have several windows, and each is its own page target. `--window <n>`
picks the one whose url carries `?window=<n>`. Main hands out that index, which is stable
across the session and appears in `location.search`. Without the flag the command targets
window 0. The two-call `window.__x` pattern below depends on this: both calls must land in
the same renderer, or the second reads an `undefined` that the first never set in that
window. Pass the same `--window` to both. `window.__x`, `window.__drag` and
`window.__vnDebug` are per-renderer, and windows share no scratch space.

An agent should drive the app this way in preference to the alternatives. It needs no
screenshots and no window focus, and the exit code reflects command failure. Commands
executed this way are recorded in `commands.jsonl` like any other, so check `--history`
when unsure what actually ran.

**Ask before you act.** You can check whether a mutating command would refuse without
running it, so the check costs nothing and writes nothing:

```sh
node scripts/vn-cdp.mjs --raw "window.vn.check('story.setNext', {scene: 'arrival'}).then(r => (window.__x = r)) && 'ok'"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__x)"
#  {"state":"refuse","message":"arrival has no next scene to clear."}
```

`state` is three-valued. `undeclared` means the command states no precondition; it does
not mean the command would succeed. The DSL form (`command.check(invocation="…")`) nests
quotes two deep, which PowerShell mangles. Use `window.vn.check` with an id and props from
PowerShell, or run the DSL form from a POSIX shell.

`--raw` has four rules. Breaking one of them produces a misleading failure:

- **Return plain JSON data** (CDP uses `returnByValue`). End debug queries in
  `.explain()`, `.table()`, or a string. Live objects (`ResultSet`, DOM nodes,
  `Fragment.raw`) come back as a useless `{}`.
- **No `await`** — the expression's promise is garbage collected first, and the call fails
  with `Error: Promise was collected`. Stash the promise on a global, then read it in a
  second call:

    ```sh
    node scripts/vn-cdp.mjs --raw "window.vn.exec(\"pipeline.status()\").then(r => (window.__x = r)) && 'started'"
    node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__x).slice(0, 400)"
    ```

- **From PowerShell, quote double-outside / single-inside.** PowerShell strips inner
  double quotes when passing arguments to a native exe, so
  `--raw "document.querySelectorAll(".tg-node").length"` arrives as
  `document.querySelectorAll(.tg-node).length`. That is a syntax error, and CDP reports it
  as a bare `Uncaught` with no message. Learn to recognize this case on sight, because the
  error text does not name the cause.
- **Never dispatch and assert in one evaluation.** React re-renders after the current
  task, so the read runs against pre-event state and returns `undefined`. That `undefined`
  looks like an interaction that never happened, even though it did. Dispatch in one
  evaluation and assert in the next.

### Synthetic input

Simulating a gesture takes one evaluation per event, for the reason above and for a second
reason: window-level `pointermove`/`pointerup` listeners are installed by an effect after
the render that begins a drag, so a `down` and a `move` in the same evaluation reach no
listener at all.

```sh
node scripts/vn-cdp.mjs --raw "window.__drag.down(window.__drag.handleAt('ending')),'down'"
node scripts/vn-cdp.mjs --raw "window.__drag.move(window.__drag.centerAt('arrival')),'move'"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__drag.state())"
```

Write `state()` first. It gathers one object holding the status line, the per-element
verdict classes, and whether the transient elements exist. Every assertion diffs that
object. Two real bugs surfaced that way, and a screenshot would not have shown either one.

- **Dispatch on the surface, not the node.** `document.querySelector('.tg-node').click()`
  selects nothing and raises no error. The node layer sets `pointer-events: none`
  (`Canvas.tsx`) so that `pick` alone determines what lies under the cursor. Take the
  geometry from the node's client rect and send a real `PointerEvent` to `.graph-canvas`.
- **Confirm the pointer is where you think before blaming a hit test.** An SVG path
  reports its own midpoint (`getPointAtLength(getTotalLength()/2)`, mapped through
  `getScreenCTM`), and that value is authoritative; comparing it to the world point the
  app computed eliminated the entire coordinate pipeline in one call and left only the
  handler, which held the bug.
- **Hit-testing under a drag needs a target element.** If you resolve "what row/cell is
  the pointer over" with `elementFromPoint`, remember that during a drag the element under
  the cursor is usually the element being dragged. Fix this structurally rather than with
  a special case: give each row a full-width hit band behind everything, and add a
  `dragging` class that drops pointer events on the layers above it
  (`renderer/styles/timeline.css`). Assert the band rects against the dragged element's
  rect before simulating anything, so the geometry is checked before any events are sent.

### A whole surface at once: a scripted PASS/FAIL run

`scripts/cdp.mjs` provides the wire protocol and nothing else — `connect`, `pageTarget`,
`send`, `evaluate`, `exec` — so a script that does more than one thing holds a single
socket rather than reconnecting on every call the way `--raw` does.
`scripts/verify-prompt-chunks.mjs` is the worked example: it drives the asset pane's
prompt editor through ten steps and prints a PASS/FAIL line for each. The script had to
account for four things, and each one cost a debugging cycle to find:

- **`window.vn.exec` goes preload → main**, so it never passes through the renderer's
  `bridge.exec` and the pane's `onInvalidate` does not fire. A command driven from a
  script therefore leaves the surface stale. The script re-reads the surface the way a
  click would, by retoggling the subject, and it must retoggle through a different
  subject, because `applyView` ignores an empty one.
- **The editors' shadow roots are open, but `document.querySelectorAll` still does not
  cross them.** Walk the tree yourself and recurse into `.shadowRoot` for every element
  that has one. A selector that matches nothing raises no error, so the failure looks like
  a missing feature.
- `Input.dispatchMouseEvent` produces a real pointer with a valid `pointerId`, so
  `setPointerCapture` works and a drag can be exercised end to end: down, move, assert
  nothing moved yet, up. Synthetic `PointerEvent`s dispatched from JS do not capture.
- **Poll, never sleep.** Read in a loop with a deadline after every command. The surface
  updates after the store, and a fixed `sleep` that passes on a warm machine fails on a
  cold one.

### UI bugs: ask `window.__vnDebug`, not a screenshot

Dev builds install the 2D debug surface (`@vn/debug2d`) on the renderer's `window`. The
surface reports what is on screen, in what order, and why, drawing on captured ground
truth:

```sh
node scripts/vn-cdp.mjs --raw "window.__vnDebug.explainPick(400, 300)"
node scripts/vn-cdp.mjs --raw "window.__vnDebug.at(400, 300).explain()"
node scripts/vn-cdp.mjs --raw "window.__vnDebug.at(400, 300).table()"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__vnDebug.owners())"
```

- **"Why did my click miss / hit the wrong thing?"** → `explainPick(x, y)`. It prints the
  winning element and an ordered rejection log: `pick='none'`,
  `clipped away by <ancestor>`, `alpha 0 — but pick='auto'`, and
  `z-index N ignored — <ancestor> established a stacking context via <reason>`.
- **"What's on top here?"** → `at(x, y)` returns the pick geometry, which is what a click
  would do. `at(x, y, { using: 'paint' })` returns what is drawn, including
  `pointer-events: none` layers.
- **"What's in this region?"** →
  `inAABB(rect, { mode: 'intersect' | 'contain' | 'center' })`.
- **"Did this room mount anything at all?"** → `capture().fragments.length`. Note that
  `capture()` returns a frame (`{index, t, fragments, spaces, caps, fidelity, oracle}`)
  rather than an array. `capture().length` is therefore `undefined`, and an `undefined`
  result looks like a broken debug layer rather than a wrong property.
- Chain filters with `.byTag()`, `.byOwner().descendants()`, `.bySource()`, and
  `.where(pred)`.

**Check which ids exist before believing an empty result.** `byOwner` is an exact match on
`f.owner.id`, and fiber-derived ids are `Component/label` — `AttemptLoop/div.loop`, never
bare `AttemptLoop`. An empty result from a query engine reads as "the thing isn't there",
and that is the worst failure mode for a debug tool because it sends you to the renderer.
One call to `owners()` settles which ids exist, and `where(f => f.owner.id.startsWith(…))`
matches on a prefix. (`owners()` returns objects, so it stringifies to `[object Object]`
in a joined expression — take the fields you want, or end in `.table()`.)

These caveats matter when interpreting the output. DOM frames are `fidelity: 'sampled'`,
so anything that changed and reverted between captures is invisible. They are also
`exactZ: false`, so the order is computed from CSS 2.1 rather than observed from paint. A
`⚠ oracle disagreement` line means the computed stack and the browser's
`elementsFromPoint` disagree; treat both as suspects, typically either a stale capture or
a stacking-walk bug.

Reproduce a UI bug as a regression test by rebuilding the offending stack as a synthetic
frame with `makeTestFrame()` and `staticSource()` from `@vn/debug2d`, then asserting on
`.explain()` output. That output is deterministic and fixed-precision, so it can serve as
a "golden" (expected-output reference) value.

### CSS: silent failures and cascade order

- **The browser drops an invalid CSS transform silently** — no console warning, no
  exception, no DevTools strike-through — and the layer stays at world coordinates. The
  branch editor once rendered every card piled at the canvas's left edge while the wires
  were placed correctly, and that mismatch looked like broken pointer events. Reading both
  layers' transforms out of the DOM gave the diagnosis:

    ```sh
    node scripts/vn-cdp.mjs --raw "JSON.stringify({svg: document.querySelector('.graph-wires g').getAttribute('transform'), html: document.querySelector('.graph-layer').style.transform})"
    # {"svg":"translate(567.1953125 48) scale(0.664)","html":""}
    ```

    The SVG form `translate(x y)` is not valid CSS (which needs `translate(3px, 4px)`),
    hence `transformOf` vs. `cssTransformOf`. A style that reads back empty after being
    assigned has failed to parse rather than rendered stale. When a co-transformed pair
    disagrees, read both before touching the geometry.

- **Check ordering against the CSSOM rather than the window.** Import order in
  `styles/index.css` is cascade order, and `@media` blocks add no specificity, so a
  breakpoint that lands before the base rule it narrows stops applying without any error,
  at one window size only. Computed style proves the base rule applies; only rule order
  proves the override applies:

    ```sh
    node scripts/vn-cdp.mjs --raw "(()=>{const h=[];[...document.styleSheets].forEach((ss,si)=>{let r;try{r=[...ss.cssRules]}catch(e){return}r.forEach((x,i)=>{if(/\.studio[{ >,]/.test(x.cssText))h.push(si+'.'+i)})});return h.join(',')})()"
    # 1.53 (base), 1.104 (@media override) — same sheet, override last. Correct.
    ```

    Check it live as well as in `vite build` output: dev resolves `@import` into injected
    `<style>` elements, so a dev-only ordering bug is possible. A screenshot misses such a
    bug, and so does eyeballing the app at one width.

### DevTools

The Electron window is a Chromium window. `Ctrl+Shift+I` opens the console, the element
inspector, and React DevTools-style fiber poking. The console exposes `window.__vnDebug`
and `window.vn` as live objects, with no serialization limits. Use the console when you
need interactivity. Use CDP when you need reproducibility, and use CDP if you are an
agent.

## Debugging tests

- **Tests are transpiled by esbuild** (`scripts/jest-esbuild.cjs`), which does no type
  checking. A test file can pass Jest and stay committed for a session with a real type
  error in it. `pnpm test` is not evidence that test code typechecks; only `pnpm check`
  is, and it does cover `tests/`.
- **`Task<K>` is generic, so `kind` does not narrow `inputs`.**
  `tasks.filter(t => t.kind === 'shot_image').map(t => t.inputs.shotId)` fails to compile,
  because `Task<K extends TaskKind>` (`packages/types/src/tasks.ts`) is a generic
  interface, not a discriminated union — an `AnyTask` has `inputs: TaskInputs[TaskKind]`,
  which a `kind` comparison cannot narrow. Tests cast
  (`t.inputs as TaskInputs['shot_image']`). Product code should narrow on the shape
  (`if ('shotId' in inputs)`), which narrows rather than asserts.
- **The gate is per scene, so "no shots ran" is the wrong assertion.** `planTasks`
  unblocks shots per scene, and a scene with no cast renders on the first run, before any
  approval. That assertion held only because a hand-built fixture had one scene. Assert on
  `summary.blockedOnGate`, `summary.gate.pending`, or the specific shot ids that must not
  appear:

    ```ts
    expect(first.gate.pending).toEqual(["aiko", "haruki"]);
    expect(shotIds(first.ran)).not.toContain("arrival__establishing");
    ```

- **When a filter matches nothing, print the value it filtered on** before questioning the
  machinery around it. A scripted reviewer once matched no shots because
  `ShotSpec.location` holds a variant id (`'day'`) rather than a location name. Both are
  `string`, so no type catches it. Parse structured output with `JSON.parse` rather than
  matching it with a regex; the regex matched a different field and hid the mismatch.
- **jsdom has no layout engine** — every `getBoundingClientRect` returns zeros. Never
  unit-test `dom/snapshot.ts` / `dom/source.ts` in `@vn/debug2d`, or anything else that
  needs real layout. The live CDP checks cover those files. The pure-function cores
  (stacking, pick, attribution, queries) take snapshot data and are fully testable. The
  renderer splits the same way: a `.ts` file with a `tests/` sibling is tested, and a
  `.tsx` file is not.
- **A `*.test.ts` outside a `tests/` folder never runs** — every project's `testMatch`
  requires the directory. The suite never appears in the output, so it is not passing.
- A golden-string failure in `@vn/debug2d` means the format changed. The failure is
  intended. Fix the regression, or edit the golden on purpose.
- Reproduce provider-shaped bugs with `RecordedChatBackend` fixtures rather than hitting
  the network in a loop.
- **`git diff --no-index` verifies a fixture that isn't a repo.** Run it against a
  scratchpad copy of `templates/basic` to check whether the editor changed only branch
  markers, and an empty diff after an unwire-then-rewire is a stronger round-trip test
  than anything available from inside the app:

    ```sh
    git diff --no-index -- templates/basic/scenes "$SCRATCH/branchdemo/scenes"
    ```

- **Windows temp dirs built by hand** (`@vn/testkit`'s `initRepo` already does all three).
  Set repo-local `user.email`/`user.name`, because `git commit` fails outright on a clean
  box without them. Set `core.autocrlf false`, because otherwise a diff assertion compares
  line endings that differ from the bytes the test wrote. Remove the directory with
  `rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`, because git
  leaves read-only pack files that Windows may refuse to unlink on the first attempt.

## Known traps

- **`contextBridge` deep-clones.** Anything exposed through preload loses function
  identity and cannot carry DOM nodes or fibers. Renderer code installs `window.__vnDebug`
  for that reason. Do not move the installation into preload.
- **Windows file locking.** Manifest writes are serialized through a single-writer queue
  because parallel atomic renames race on Windows. New code that produces rename/EPERM
  flakes has likely bypassed an existing single-writer path.
- Secrets never appear in logs, by design. A key-resolution error names the source (env
  var or file path), not the value. Do not add logging that changes this while debugging
  key problems — test resolution with a throwaway key instead.
- **`turbo` caching.** Internal packages have no build step, so cache invalidation depends
  on the `globalDependencies` globs in `turbo.json`. Check those globs if a bundle looks
  stale after a source edit. `pnpm build --force` bypasses the cache while you check.
- **Two command catalogs.** `apps/desktop/dist/commands.json` is a build artifact, and the
  `command:catalog` IPC channel serves the live registry. When they disagree, the file is
  stale. Rebuild it, and debug against the live registry rather than the file.
