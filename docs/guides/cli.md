# The CLI (`vngen`)

What `vngen` does, what it needs, and what a project looks like on disk. The pipeline behind it is
[`../history/vn-generator-report.md`](../history/vn-generator-report.md); the invariants it obeys are
[`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md). Run it as `node apps/cli/dist/cli.js <cmd>` or
`pnpm vngen <cmd>` after `pnpm build`.

<!-- toc -->

- [Commands](#commands)
- [`--mock`, and what a real run needs](#--mock-and-what-a-real-run-needs)
- [Project layout on disk](#project-layout-on-disk)
  * [A scene is one file](#a-scene-is-one-file)
- [The sample project](#the-sample-project)

<!-- tocstop -->

## Commands

```
vngen run [dir] [--mock]            parse → validate → execute to the next gate
vngen approve [dir] [--character][--hash][--yes]  interactively approve pending portraits
vngen status [dir]                  task/asset/approval summary
vngen graph [dir]                   emit the story branch graph (Mermaid)
vngen export [dir]                  write vngen/build/story.play.json (the playable)
vngen cost [dir]                    dry-run cost preview
vngen decompose [dir]               storyboard every reachable scene that has none yet
vngen import [dir]                  convert a retired screenplay/*.fountain into scenes/<id>.md
vngen screenplay [dir] [-o f|-][--clean]  project the scenes back to one Fountain file
```

`decompose` is the one verb that **refuses `--mock` by name**. Decomposition writes
`vngen/work/shots/<sceneId>.json`, an absent one is the only signal that means "decompose this
scene" (a first shot placed by hand writes the same file, so a scene storyboarded that way is
skipped like any other), and a mock provider yields the deterministic baseline — so a mock run
would permanently baseline the whole project. It is additive with no `force` (the file wins forever, and moving shot
ids would move task identities and re-render paid-for art), it skips a scene the model does not
answer for rather than writing a fallback, and it is the only verb that asks for the **text** key
rather than the image one: it draws nothing, so refusing it for a missing Gemini key would be a
refusal the author cannot act on. `story.decomposeAll` in the desktop app is the same function.

`run`, `status` and `cost` also know about generation graphs: a slot bound to one is drawn through
it, reported as drifted when the graph was edited since it last ran, and priced node by node. What a
graph is and what each verb prints is [`../reference/gen-graphs.md`](../reference/gen-graphs.md#the-cli).

`export` and `screenplay` are different artifacts: `export` writes the playable the desktop app
runs ([`../reference/playable-format.md`](../reference/playable-format.md)), `screenplay` writes Fountain a human (or
`vngen import`) can read. `import` runs once per project, refuses over an existing `scenes/`, and
moves the original aside as `.fountain.imported` — both are written up in full in
[`../reference/fountain.md`](../reference/fountain.md#one-fountain-file-in-and-out-project-specific).

## `--mock`, and what a real run needs

`--mock` makes `run` a **dry run**: it plans, writes the story graph, and previews the work (like
`cost`) but calls no model and writes no assets — no API keys needed.

Without `--mock`, `run` constructs real Gemini/Claude clients and requires a Gemini key. Four
places are consulted, and the **first** that answers wins:

1. The environment variable named in `project.yaml` (`config.keys.<vendor>`).
2. A secret file under `<dir>/keys/`.
3. A shared `keys/` at the enclosing repo root.
4. `<user config dir>/keys/` — `%LOCALAPPDATA%\vnauthor` on Windows,
   `~/Library/Application Support/vnauthor` on macOS, `$XDG_CONFIG_HOME/vnauthor` (else
   `~/.config/vnauthor`) on Linux. `$VNAUTHOR_HOME` overrides all three, and a pre-existing
   `~/.vnauthor` is still read when the native directory does not exist.

So a project carrying its own key wins over the one set up once for the machine, and a set
environment variable wins over both — which is the honest answer to "why is it still asking me"
after a key was just pasted. `vnauthor` resolves model and keys exactly the same way
([`../reference/vnauthor.md`](../reference/vnauthor.md#running-it)); getting a key in the first place is
[`api-keys.md`](api-keys.md).

`vngen run --mock` writes no assets at all. Mock providers used *directly* — tests, `@vn/testkit`
— do emit **marked placeholder PNGs**, and a real backend refuses any reference carrying that
marker; see [`testkit.md`](testkit.md#placeholder-art-and-the-recorded-corpus).

## Project layout on disk

Authored input lives at the project root: `project.yaml`, `characters/<id>/character.md`,
`locations/<id>.md`, `scenes/<id>.md`. Those are the conventional homes, and where a _new_ sheet is
created — but a character or location tagged `type:` under `wiki/**` is discovered there too
([`../plans/archive/INDEX.md#entity-discovery-by-meta-tag`](../plans/archive/INDEX.md#entity-discovery-by-meta-tag)).

**Base art is the one generated thing that is not under `vngen/`.** `assets/` (`manifest.json` +
`objects/<hash>.<ext>`) sits at the project root because it is its own subtree and may be its own
repo — [`../reference/asset-stores.md`](../reference/asset-stores.md). Everything else generated lives under `vngen/`:

- `work/` — human-editable: the story graph, candidates, `approved.png`, `shots/<sceneId>.json`
- `build/` — machine: shot `assets/`, `manifest.json`
- `state/` — `tasks.jsonl`, reviews

In a user's own project `vngen/` is **committed**. It is the reproducible output of a run, not
something to gitignore. `templates/basic` is the one exception: it is a template this repo ships,
so it stays inputs-only. Anything you actually run lives under `examples/`, which is gitignored
whole — that is what the directory is for.

**A project the app initializes gets a `.gitignore` before its first commit** — `keys`,
`node_modules`, `.DS_Store`, and deliberately **not** `vngen/`, which is the whole reason the file
is written here rather than left to a template. `keys` is the load-bearing line: the desktop app
commits the worktree after every mutating command, so a key git can see is committed within the
second.

### A scene is one file

`scenes/<id>.md` holds `scene: <id>` front-matter — identity and nothing else, matching the
filename — over a body that is a complete one-scene Fountain screenplay, heading and `[[…]]`
markers included. A directory has no document order, so the entry scene is `start:` in
`project.yaml`.

The older one-contended-file form (`screenplay/*.fountain`) is **not read**: a project holding one
and no `scenes/` gets an error naming `vngen import`, and one left beside chunks is a warning to
delete or rename it `.fountain.imported`. What a body may contain:
[`../reference/fountain.md`](../reference/fountain.md#where-the-fountain-lives-project-specific); why the reader is the only
thing that decides: [`../reference/pipeline-contracts.md`](../reference/pipeline-contracts.md#scenes-shots-and-lines).

## The sample project

[`templates/basic`](../../templates/basic) is a small branching VN, and a **read-only template**: the
desktop app copies it rather than running in it (see
[`../reference/desktop-app-state.md`](../reference/desktop-app-state.md#seeded-workspace-examplesmysamplerepo)). The CLI has no such
indirection — it runs wherever you point it — so copy it first. `examples/` is gitignored whole and
exists for exactly this, which keeps a real run's ~100 MB of generated art out of `git status`.

Preview offline, then generate:

```sh
pnpm build
cp -r templates/basic examples/walkthrough
node apps/cli/dist/cli.js graph  examples/walkthrough
node apps/cli/dist/cli.js run    examples/walkthrough --mock  # dry run: previews planned work
# a real run needs a Gemini key (see above); it generates portraits, then halts at the gate:
node apps/cli/dist/cli.js run    examples/walkthrough
node apps/cli/dist/cli.js approve examples/walkthrough        # interactively approve portraits
node apps/cli/dist/cli.js run    examples/walkthrough         # clears the gate, renders shots
node apps/cli/dist/cli.js status examples/walkthrough
node apps/cli/dist/cli.js export examples/walkthrough         # write the playable (story.play.json)
```
