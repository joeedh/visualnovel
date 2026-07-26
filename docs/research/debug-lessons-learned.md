# Debug lessons learned

<!-- toc -->

- [test-fixtures (`@vn/testkit`)](#test-fixtures-vntestkit)
  * [A stale `dist/commands.json` fails the desktop suite, and it looks like your change](#a-stale-distcommandsjson-fails-the-desktop-suite-and-it-looks-like-your-change)
  * [`Task` is generic, so `kind` does not narrow `inputs`](#task-is-generic-so-kind-does-not-narrow-inputs)
  * [The gate is per scene — "no shots ran" is the wrong assertion](#the-gate-is-per-scene--no-shots-ran-is-the-wrong-assertion)
  * [Windows: three things a git-backed temp dir needs](#windows-three-things-a-git-backed-temp-dir-needs)
  * [A new workspace package's deps aren't linked until `pnpm install`](#a-new-workspace-packages-deps-arent-linked-until-pnpm-install)
- [0 · Renderer restructure](#0-%C2%B7-renderer-restructure)
  * [A check that passes on the first run has not been shown to work](#a-check-that-passes-on-the-first-run-has-not-been-shown-to-work)
  * [Splitting a stylesheet: diff the emitted rules, not the sources](#splitting-a-stylesheet-diff-the-emitted-rules-not-the-sources)
  * [Verifying "all three rooms still render" without a screenshot](#verifying-all-three-rooms-still-render-without-a-screenshot)
  * [Killing the dev loop leaves Electron running](#killing-the-dev-loop-leaves-electron-running)
- [1 · Refine-loop inspector](#1-%C2%B7-refine-loop-inspector)
  * [A UI for a rare state is unfalsifiable until you can produce the state](#a-ui-for-a-rare-state-is-unfalsifiable-until-you-can-produce-the-state)
  * [The false trail: every shot came out one-attempt anyway](#the-false-trail-every-shot-came-out-one-attempt-anyway)
  * [`byOwner` is an exact match, so the component name matches nothing](#byowner-is-an-exact-match-so-the-component-name-matches-nothing)
  * [`--raw` with an `await` returns *Promise was collected*](#--raw-with-an-await-returns-promise-was-collected)
  * [Verify a degraded state by building one, not by assuming it](#verify-a-degraded-state-by-building-one-not-by-assuming-it)
  * [Orphaned Electron, again — the PowerShell form](#orphaned-electron-again--the-powershell-form)
- [2 · Story branch editor](#2-%C2%B7-story-branch-editor)
  * [An invalid CSS transform is dropped silently, and the layer just sits at world coordinates](#an-invalid-css-transform-is-dropped-silently-and-the-layer-just-sits-at-world-coordinates)
  * [The drag was fine; the app under CDP was the previous build](#the-drag-was-fine-the-app-under-cdp-was-the-previous-build)
  * [Simulating a drag over CDP takes one evaluation per event](#simulating-a-drag-over-cdp-takes-one-evaluation-per-event)
  * [Confirm a synthetic pointer's coordinates against the geometry, not the code](#confirm-a-synthetic-pointers-coordinates-against-the-geometry-not-the-code)
  * [A marker-only patch is verifiable with `git diff --no-index`](#a-marker-only-patch-is-verifiable-with-git-diff---no-index)
- [3 · Task DAG view](#3-%C2%B7-task-dag-view)
  * [The desktop app cannot produce tasks at all in mock mode](#the-desktop-app-cannot-produce-tasks-at-all-in-mock-mode)
  * [A live CDP session leaves provenance in the workspace](#a-live-cdp-session-leaves-provenance-in-the-workspace)
  * [A synthetic click on a graph node does nothing, by design](#a-synthetic-click-on-a-graph-node-does-nothing-by-design)
  * [PowerShell eats the inner quotes of a `--raw` expression](#powershell-eats-the-inner-quotes-of-a---raw-expression)
  * [Killing a stale dev loop on Windows, by command line](#killing-a-stale-dev-loop-on-windows-by-command-line)
- [4 · Shot timeline](#4-%C2%B7-shot-timeline)
  * [The repair was correct and produced no change, because the reader never read it](#the-repair-was-correct-and-produced-no-change-because-the-reader-never-read-it)
  * [A jest-green test file can still fail `tsgo`](#a-jest-green-test-file-can-still-fail-tsgo)
  * [Reading React state in the same evaluation that dispatched the event](#reading-react-state-in-the-same-evaluation-that-dispatched-the-event)
  * [`elementFromPoint` under a drag needs somewhere to land](#elementfrompoint-under-a-drag-needs-somewhere-to-land)

<!-- tocstop -->

Scratch accumulator for the [desktop editors](../plans/desktop-editors-tracking.md) plans.
One section per plan, appended in that plan's own final commit: what actually went wrong,
what produced the evidence, and the false trail if there was one. A lesson with no symptom
attached is not a lesson.

This file is **not** the debugging guide. When every plan in the tracking table is done it
gets consolidated into [`../debugGuide.md`](../debugGuide.md) — reorganized by symptom,
cheapest-first — and then deleted, in two separate commits. Until then, prefer raw and
specific over tidy.

## test-fixtures (`@vn/testkit`)

### A stale `dist/commands.json` fails the desktop suite, and it looks like your change

**Symptom.** After adding `apps/desktop/src/main/tests/session.test.ts`, the desktop jest
project went red — but in `commands/tests/commands.test.ts`, a file the change never
touched.

**Evidence.** The jest diff listed exactly one missing catalog entry, `view.panelSize` — a
command added by an earlier commit. `apps/desktop/dist/` is a gitignored build output, so
`git status` shows nothing and a fresh `pnpm test` reproduces it forever.

```sh
node scripts/gen-command-catalog.mjs   # "commands.json: 14 command(s)" — green again
```

**Lesson.** That test compares a **build artifact** to the live registry, so it is red from
the moment a command changes until someone rebuilds. If a suite fails in a file your diff
doesn't touch, check whether the assertion's other side is generated before reading any
source. The catalog is regenerated by `pnpm build` (or the script directly), not by `pnpm test`.

### `Task<K>` is generic, so `kind` does not narrow `inputs`

**Symptom.** `tasks.filter(t => t.kind === 'shot_image').map(t => t.inputs.shotId)` fails to
compile: *Property 'shotId' does not exist on type …*.

**Why.** `Task<K extends TaskKind>` (`packages/types/src/tasks.ts`) is a generic interface,
not a discriminated union of object types. An `AnyTask` has `inputs: TaskInputs[TaskKind]`,
a union that a `kind` comparison cannot narrow.

```ts
const shotIds = (tasks: AnyTask[]): string[] =>
  tasks
    .filter((t) => t.kind === 'shot_image')
    .map((t) => (t.inputs as TaskInputs['shot_image']).shotId);
```

The cast is the idiom; every test that inspects task inputs by kind needs it. In *product*
code, prefer narrowing on the shape — `if ('shotId' in inputs)` — which is a real narrowing
rather than an assertion, and is what `subjectOf` (`renderer/rooms/floor/taskGraph.ts`) does.

### The gate is per scene — "no shots ran" is the wrong assertion

**Symptom (avoided, by prediction rather than by failure).** The obvious first-run assertion,
`expect(ran.some(t => t.kind === 'shot_image')).toBe(false)`, is what `scheduler.test.ts`
had. It is wrong on any multi-scene project: `planTasks` unblocks shots **per scene**, so a
scene with no cast (`good_end`, `bad_end` in `SCRIPTS.branching`) renders on the first run,
before any approval. The old assertion held only because the hand-built model had one scene.

**Lesson.** Assert on `summary.blockedOnGate`, `summary.gate.pending`, or the specific shot
ids that must *not* appear:

```ts
expect(first.gate.pending).toEqual(['aiko', 'haruki']);
expect(shotIds(first.ran)).not.toContain('arrival__establishing');
```

This is the class of bug an in-memory single-scene fixture hides — the reason the fixture
now builds a real multi-scene project on disk.

### Windows: three things a git-backed temp dir needs

No failure was observed here — these are pre-emptive, and recorded so the next fixture
doesn't rediscover them. `git.test.ts` already carried the first one, reaching through a
cast to the private `Git.run` three times to set it; testkit absorbs that once in `initRepo`.

- **`git init` in a temp dir inherits no identity**, so `git commit` fails outright on a
  clean box. Set repo-local `user.email` / `user.name`.
- **`core.autocrlf false`**, or a diff assertion compares different line endings than the
  bytes the test wrote (the repo is all-LF via `.gitattributes`).
- **`rm` needs retries** — git leaves read-only pack files Windows may refuse to unlink on
  the first attempt: `rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`.

### A new workspace package's deps aren't linked until `pnpm install`

**Symptom.** `pnpm check` reports `Cannot find module 'yaml'` in a brand-new package while
every other package resolves it fine.

**Lesson.** Adding `packages/<name>/package.json` doesn't create its `node_modules` link.
Run `pnpm install` once after scaffolding a package — before concluding anything about
tsconfig `paths`, which resolve `@vn/*` but not third-party deps.

## 0 · Renderer restructure

### A check that passes on the first run has not been shown to work

**Symptom.** Wave 1 added `tsgo --noEmit -p renderer/tsconfig.json` to code that had *never*
been typechecked. The plan budgeted for "a pile" of errors. It exited 0, first try, 11 files.

That is the ambiguous outcome, not the good one: a `tsconfig` whose `include` matches nothing,
or a `-p` pointed at a file that doesn't exist, also exits 0. The cheapest disambiguation is to
break it on purpose:

```sh
echo 'const _deliberate: number = "not a number";' >> apps/desktop/renderer/main.tsx
pnpm check          # expect TS2322 and exit 1
git checkout apps/desktop/renderer/main.tsx
```

**Lesson.** Any new gate gets a falsification pass before it is called green. This is the same
reason a test you have never seen fail is not evidence.

### Splitting a stylesheet: diff the emitted rules, not the sources

**Symptom (potential, caught before it shipped).** Splitting one 1260-line sheet into six is
exactly the change where a cascade regression hides — `@media` blocks add no specificity, so a
breakpoint that ends up *before* the base rule it narrows silently stops applying. Nothing type-
checks it and the bundle size barely moves (19.30 kB → 19.30 kB, gzip 4.42 → 4.41 kB), so
"the build still works" proves nothing.

**Evidence — the normalization matters.** Compare the *emitted* CSS from `vite build`, one rule
per line. The obvious first attempt is wrong:

```sh
tr '}' '}\n' < before.css     # WRONG: tr maps char→char, so '}\n' is truncated to '}'
sed 's/}/}\n/g' < before.css  # right
```

With that fixed, two questions, in order — the set first, because an order diff on differing
sets is unreadable:

```sh
for f in before after; do sed 's/}/}\n/g' $f.css | sed '/^$/d' > $f.rules; done
diff <(sort before.rules) <(sort after.rules)   # same rules at all?  (199 = 199)
diff before.rules after.rules                   # then: which ones moved, and does it matter?
```

Every moved rule is only a problem if some *other* rule it crossed shares a matching selector.
Two blocks moved here (`.cmdbtn` past the `.overlay`/`.pal-*` group, and both `@media` blocks
earlier); a `grep` for each moved selector in `after.rules` showed each override still sits
after its base rule, and nothing re-matches afterward.

**Confirm it live**, because the dev server assembles the sheet differently than `vite build`
does — dev resolves `@import` into injected `<style>` elements, so dev-only ordering bugs are
possible. Ask the CSSOM directly rather than looking at the window:

```sh
node scripts/vn-cdp.mjs --raw "(()=>{const h=[];[...document.styleSheets].forEach((ss,si)=>{let r;try{r=[...ss.cssRules]}catch(e){return}r.forEach((x,i)=>{if(/\.studio[{ >,]/.test(x.cssText))h.push(si+'.'+i)})});return h.join(',')})()"
# 1.53 (base), 1.104 (@media override) — same sheet, override last. Correct.
```

**Negative result.** A screenshot would not have caught this, and neither would eyeballing the
app at one window size: the `@media` blocks only apply under 860/980 px. Computed style via CDP
(`getComputedStyle(document.querySelector('.studio')).gridTemplateColumns` → `"212px 1134.4px"`)
proves the base rule; only the CSSOM rule order proves the override.

### Verifying "all three rooms still render" without a screenshot

`view.room` is a real command, so the room switch and the render are both checkable from the
shell. `capture()` returns a **frame** (`{index, t, fragments, spaces, caps, fidelity, oracle}`),
not an array — `capture().length` is `undefined`, which reads as a broken debug layer rather
than a wrong property:

```sh
for r in studio floor play; do
  node scripts/vn-cdp.mjs "view.room(name='$r')" > /dev/null
  node scripts/vn-cdp.mjs --raw "window.__vnDebug.capture().fragments.length"
done
# 77 / 47 / 39 — each room mounts substantive DOM
```

`owners()` returns objects, so it stringifies to `[object Object]` in a joined expression; take
the fields you want, or end in `.table()`.

### Killing the dev loop leaves Electron running

**Symptom.** `scripts/dev.desktop.mjs` tears its tree down on Ctrl-C, but killing the pnpm
process from outside is not Ctrl-C — four `electron.exe` processes survived, still holding the
CDP port.

**Evidence.** The listener names the culprit PID, and that PID is the parent of the rest:

```sh
netstat -ano | grep 127.0.0.1:9222   # → LISTENING <pid>
```

Kill that process's children then the process itself, rather than every `electron.exe` on the
box — on a dev machine, some of those belong to the user's editor.

## 1 · Refine-loop inspector

### A UI for a rare state is unfalsifiable until you can produce the state

**Symptom.** Nothing. That is the problem: the inspector renders multi-attempt `shot_image`
tasks, and no fixture in the repo produces one. A mock run gives every shot exactly one
attempt, so every rendering decision — the spine, the correction gap, the triage block —
would have been checked against a shape that never occurs.

The plan's two suggested fixtures both fail on inspection, before any code:

- **Hand-written `tasks.jsonl`.** It can fabricate three attempts, but each attempt's
  thumbnail is `vnasset://<hash>.<ext>` served from `build/assets/` — bytes that a
  hand-written log does not have. It tests the half that was never in doubt.
- **`examples/sample` run for real.** The refine loop only re-runs when a reviewer *blocks*,
  which is not reproducible on demand, and a committed sample project must never carry
  fabricated provenance.

**What worked.** A throwaway project from `@vn/testkit` driven through the **real**
`runPipeline`, with two scripted backends: an image backend emitting real PNG bytes, and a
reviewer backend that blocks the first N attempts of chosen shots and then passes. Both seams
already exist for mock runs — the only new thing is a policy that varies by shot. That yields
genuine `done`-after-three and `needs_human` tasks, with real bytes in the store and a real
`tasks.jsonl` written by the code under test.

**Lesson.** When a display is for a state the app rarely reaches, the fixture is the hard
part and it comes first. Building the UI first means discovering the shape is wrong after
it is styled.

### The false trail: every shot came out one-attempt anyway

**Symptom.** With the scripted reviewer in place, the run still produced nothing but
single-attempt tasks. The obvious readings — the policy never fires, the runner ignores
verdicts, `max_refine_attempts` is 1 — were all wrong.

**Evidence.** Log what the policy actually receives, not what you think it receives:

```
shot spec: {"location":"day", ...}   # expected "dorm_room"
```

`ShotSpec.location` is a **variant id** (`packages/pipeline/src/p5.ts:26,42`), not a location
name, and every testkit location defaults to `variants: ['day']`. So every shot in the project
reported the same location and a policy keyed on the location name matched none of them. Fixed
by giving each location a distinct first variant.

**Lesson.** A field named `location` holding `"day"` is the kind of thing a type cannot catch
(both are `string`). When a filter matches nothing, print the value it filtered on before
questioning the machinery around it. Secondary: parse the spec (`JSON.parse`) rather than
regexing it — the regex "worked" and hid the mismatch by matching a different field.

### `byOwner` is an exact match, so the component name matches nothing

**Symptom.** The plan's own verification command returns `[]` on a panel that is visibly
rendering:

```sh
node scripts/vn-cdp.mjs --raw "window.__vnDebug.byOwner('AttemptLoop').table()"   # []
```

**Why.** `byOwner` compares `f.owner.id` for equality, and fiber-derived ids are
`Component/label` — `AttemptLoop/div.loop`, never bare `AttemptLoop`. An empty result from a
query engine reads as "the thing isn't there", which is the worst possible failure mode for a
debug tool: it sends you to look at the renderer.

```sh
node scripts/vn-cdp.mjs --raw "window.__vnDebug.where(f => f.owner.id.startsWith('AttemptLoop')).table()"
node scripts/vn-cdp.mjs --raw "window.__vnDebug.owners().map(o => o.id).join(',')"   # when unsure of the id
```

**Lesson.** Before believing an empty query result, ask the engine what ids exist. `owners()`
is one call and settles it.

### `--raw` with an `await` returns *Promise was collected*

**Symptom.** Reading an IPC result over CDP fails with `Error: Promise was collected` rather
than returning anything — the expression's promise is GC'd before the evaluation resolves.

**Workaround.** Split it across two calls: stash on a global, then read the global.

```sh
node scripts/vn-cdp.mjs --raw "window.vn.exec(\"pipeline.status()\").then(r => (window.__x = r)) && 'started'"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__x).slice(0, 400)"
```

### Verify a degraded state by building one, not by assuming it

**Symptom (avoided).** "A mock run has no assets, so the thumbnails will be empty" is a
prediction, and the interesting question is *how* it is empty — a `<img src>` that 404s
renders a broken-image icon, which is a bug, not a design.

**What produced the evidence.** A copy of the fixture with `build/assets/` emptied and the
manifest reduced to an empty asset list, then counted directly:

```sh
node scripts/vn-cdp.mjs --raw "JSON.stringify({imgs: document.querySelectorAll('.att-shot img').length, none: document.querySelectorAll('.att-shot.none').length})"
# {"imgs":0,"none":3}  — placeholders, and no <img> emitted at all
```

Zero `<img>` is the load-bearing half: the url is built only when the attempt resolved an
`outputExt` from the manifest, so a missing asset never becomes a request.

**Trap.** `manifest.json` is `{"version":1,"assets":[…]}`, not a bare array. Writing `[]`
produces a manifest that fails to parse rather than one that is empty, and the app degrades
along a completely different path than the one being tested.

### Orphaned Electron, again — the PowerShell form

Plan 0's entry recurred verbatim: stopping the background dev-loop task twice left
`electron.exe` on CDP 9222 and `node.exe` on Vite 5176. It is not a one-off, so the reusable
form, without needing `netstat` + `grep`:

```powershell
Get-NetTCPConnection -LocalPort 9222,5176 -State Listen | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $($_.OwningProcess)" | Stop-Process -Force
  Stop-Process -Id $_.OwningProcess -Force
}
```

Then re-query the ports to confirm they are released — the kill can succeed while a child
keeps the socket.

## 2 · Story branch editor

### An invalid CSS transform is dropped silently, and the layer just sits at world coordinates

**Symptom.** The branch editor rendered — right number of cards, right wires, right labels —
but every card sat piled at the canvas's left edge while the wires were correctly placed.
Simulated drags did nothing, which read as "pointer events are broken".

**What produced the evidence.** Reading the two layers' transforms side by side, rather than
looking at the drag code at all:

```sh
node scripts/vn-cdp.mjs --raw "JSON.stringify({svg: document.querySelector('.graph-wires g').getAttribute('transform'), html: document.querySelector('.graph-layer').style.transform})"
# {"svg":"translate(567.1953125 48) scale(0.664)","html":""}
```

An empty `style.transform` after assigning a non-empty string is the whole diagnosis: the SVG
form (`translate(x y)`) is not valid CSS (which needs `translate(3px, 4px)`), and CSS drops a
transform it cannot parse without an error anywhere — no console warning, no exception, no
DevTools strike-through. Fixed by a separate `cssTransformOf`, with a test pinning both forms
so they cannot be swapped again.

**Lesson.** When a co-transformed pair disagrees, read *both* transforms out of the DOM before
touching the geometry. And treat "assigned a style, read it back empty" as a parse failure
rather than a stale render.

### The drag was fine; the app under CDP was the previous build

**False trail, and the expensive one.** Two rounds of "the pointerdown isn't reaching React"
were spent on an app started with `pnpm --filter @vn/desktop start`, which serves the *built*
renderer — so every source edit was invisible. `dev` is the loop with HMR.

Symptom to recognize: a fix that changes behaviour not at all, twice, with no error. Before
diagnosing further, confirm the running app contains the change (bump something observable, or
just use `dev`). Related and already recorded above: a stale Electron on 9222 means CDP is
talking to an app you didn't start.

### Simulating a drag over CDP takes one evaluation per event

React batches state updates, and the window-level `pointermove`/`pointerup` listeners are
installed by an effect *after* the render that begins the drag. A `down` and a `move` in the
same evaluation therefore reach no listener, and reading the DOM in that same task shows the
pre-drag state either way. One `vn-cdp.mjs` call per event, one more to assert:

```sh
node scripts/vn-cdp.mjs --raw "window.__drag.down(window.__drag.handleAt('ending')),'down'"
node scripts/vn-cdp.mjs --raw "window.__drag.move(window.__drag.centerAt('arrival')),'move'"
node scripts/vn-cdp.mjs --raw "JSON.stringify(window.__drag.state())"
```

The helper worth writing first is `state()` — one object with the status line, the per-wire
verdict classes, and whether the ghost/carried elements exist. Every assertion in the wave was
a diff of that object, and it made two real bugs obvious that a screenshot would not have:
`over` staying `null` through the press→splice transition, and a grab disc unreachable from
one side.

### Confirm a synthetic pointer's coordinates against the geometry, not the code

Before blaming a hit-test, check the pointer is where you think it is. The SVG path's own
midpoint is ground truth, and `getScreenCTM` maps it to client coordinates:

```sh
node scripts/vn-cdp.mjs --raw "(()=>{const p=document.querySelectorAll('.graph-wire')[2];const w=p.getPointAtLength(p.getTotalLength()/2);/* …compare to the world point the app computes… */})()"
```

That returned a discrepancy of 0.0005 world units — which eliminated the entire coordinate
pipeline in one call and left only the handler, where the bug was.

### A marker-only patch is verifiable with `git diff --no-index`

The fixture is a copy of `examples/sample` in the scratchpad, so it is not a git repo — but the
assertion "the editor changed only branch markers" is still one command:

```sh
git diff --no-index -- examples/sample/screenplay "$SCRATCH/branchdemo/screenplay"
```

Empty output after an unwire-then-rewire is also the round-trip test, and it is stronger than
any assertion available from inside the app.

## 3 · Task DAG view

### The desktop app cannot produce tasks at all in mock mode

**Symptom.** FLOOR's new graph showed a gate barrier and seven ghosts and *zero* real nodes on
`examples/sample`, no matter how many times `pipeline.run` was invoked. This reads exactly like
a broken derivation.

**What produced the evidence.** The command's own result, which says so:

```sh
node scripts/vn-cdp.mjs "pipeline.run(mock=true)"   # → ok, "ran 0 tasks"
```

`session.ts` passes `mock` straight through as `dryRun`, so a mock run plans and previews and
writes nothing. The app has exactly two states available without an API key: no tasks, or a
project that already had them.

**Lesson.** On-disk task state comes from `@vn/testkit`, not from the app. A throwaway jest
test that builds the fixtures and prints their paths is the cheapest bridge — one for the
gate-halted state, one run through `approveAll()` for the cleared state — then
`$env:VN_PROJECT=<dir>` before the dev loop. Delete the test afterwards; it carries a
`CLAUDENOTE:` for exactly that reason. **Never** point a run at `examples/sample` to get
tasks: the sample's committed `vngen/` tree is authored output, and fabricated provenance in it
is worse than no fixture.

### A live CDP session leaves provenance in the workspace

`git status` after the verification pass showed an untracked `examples/sample/vngen/state/` —
every `view.*` command executed over CDP had appended a `CommandRecord` to `commands.jsonl` in
whatever workspace the app was pointed at. Harmless, but it is generated data in a committed
tree, so **run `git status` at the end of any live session**, not only at the end of the code.

### A synthetic click on a graph node does nothing, by design

`document.querySelector('.tg-node').click()` selects nothing and produces no error: the node
layer is `pointer-events: none` (`Canvas.tsx`), because `pick` is meant to be the single answer
to "what is under the cursor". Nor does dispatching at `elementFromPoint` help — that lands on
the SVG wire layer. Dispatch a real `PointerEvent` on the **surface**, at the node's client
rect centre:

```sh
node scripts/vn-cdp.mjs --raw "(()=>{const n=[...document.querySelectorAll('.tg-node')][3],r=n.getBoundingClientRect();document.querySelector('.graph-canvas').dispatchEvent(new PointerEvent('pointerdown',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,pointerId:1,button:0,isPrimary:true}));return JSON.stringify({sel:document.querySelectorAll('.tg-node.sel').length})})()"
```

Same shape as the drag helper from plan 2: the geometry comes from the DOM, the event goes to
the surface, and the assertion is one JSON object.

### PowerShell eats the inner quotes of a `--raw` expression

**Symptom.** `vn-cdp.mjs --raw` printed a bare `Uncaught` with no message. The expression was
fine in DevTools.

PowerShell strips inner double quotes when passing arguments to a native exe, so
`--raw "document.querySelectorAll(".tg-node").length"` arrives as
`document.querySelectorAll(.tg-node).length` — a syntax error, which CDP reports without a
description. Quote the other way round: **double outside, single inside**. Worth recognizing on
sight, because the error text points nowhere.

### Killing a stale dev loop on Windows, by command line

The port collision from plan 2 (`Port 5176 is already in use`, CDP `bind() returned an error`)
recurs whenever a session ends without tearing the loop down. There is no pidfile; match on the
command line:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dev.desktop.mjs*' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F }
```

`/T` matters — esbuild, Vite and Electron are children, and killing only the parent leaves the
ports held.

## 4 · Shot timeline

### The repair was correct and produced no change, because the reader never read it

**Symptom.** Two scenes in the seeded workspace had accepted shot images and displayed none.
Hand-editing `coversLines` in `vngen/work/shots/<scene>.json` — the documented free repair —
changed nothing: the exported playable still had `withImage 0`.

**What produced the evidence.** A throwaway esbuild-bundled script that called `buildPlayable`
directly and counted `show` beats with and without an image. The file edit was fine; the
exporter never opened the file. `coveringShots` consulted `scene.shots`, which a model rebuilt
from disk never has, so it reconstructed the deterministic baseline for every scene and named
shot ids the LLM-decomposed run had never produced.

**Lesson.** When a data edit "does nothing", check that the consumer reads that source at all
before re-checking the edit. Two independent faults were stacked here — a prompt that made
`coversLines` unanswerable, and a reader that ignored the answer — and each alone blanks the
scene, so fixing either one leaves the symptom exactly as it was.

### A jest-green test file can still fail `tsgo`

`packages/testkit/src/tests/record.test.ts` had a real type error (`string | undefined` where
`string` was required) and had been committed and passing for a session. The jest transform is
esbuild, which strips types without checking them. **`pnpm test` is not evidence that test code
typechecks** — only `pnpm check` is, and it covers `tests/` too.

### Reading React state in the same evaluation that dispatched the event

**Symptom.** A synthetic `pointermove` over the timeline produced `undefined` for the preview
notice, suggesting the drag never started. It had: a second CDP call a moment later found both
`.tl-grid.dragging` and the notice text.

The dispatch and the query were in one `Runtime.evaluate` expression, so the read happened
before React re-rendered. **Split dispatch and assertion into separate `--raw` calls** — the
same discipline as one evaluation per pointer event, for the same reason.

### `elementFromPoint` under a drag needs somewhere to land

The strip resolves "which line is the pointer over" from the DOM rather than from measured
row geometry, but a drag lives in the bracket columns, where the only thing under the cursor is
the bracket being dragged. The fix is structural, not a special case in the hit test: a
full-width `.tl-band` per row behind everything, plus a `dragging` class that drops pointer
events on the script and the brackets so the band is reachable. Verified by asserting the band
rects against the bracket rects before simulating anything — geometry first, then events.
