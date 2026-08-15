# The CLI (`vngen`)

What `vngen` does, what it needs, and what a project looks like on disk. The pipeline behind it is
[`vn-generator-report.md`](vn-generator-report.md); the invariants it obeys are
[`pipeline-contracts.md`](pipeline-contracts.md). Run it as `node apps/cli/dist/cli.js <cmd>` or
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
vngen import [dir]                  convert a retired screenplay/*.fountain into scenes/<id>.md
vngen screenplay [dir] [-o f|-][--clean]  project the scenes back to one Fountain file
```

`export` and `screenplay` are different artifacts: `export` writes the playable the desktop app
runs ([`playable-format.md`](playable-format.md)), `screenplay` writes Fountain a human (or
`vngen import`) can read. `import` runs once per project, refuses over an existing `scenes/`, and
moves the original aside as `.fountain.imported` — both are written up in full in
[`fountain.md`](fountain.md#one-fountain-file-in-and-out-project-specific).

## `--mock`, and what a real run needs

`--mock` makes `run` a **dry run**: it plans, writes the story graph, and previews the work (like
`cost`) but calls no model and writes no assets — no API keys needed.

Without `--mock`, `run` constructs real Gemini/Claude clients and requires a Gemini key: the env
var named in `project.yaml`, or a secret file under `<dir>/keys/`, or a shared `keys/` at the
enclosing repo root, consulted after the project's own. `vnauthor` resolves model and keys exactly
the same way ([`vnauthor.md`](vnauthor.md#running-it)).

`vngen run --mock` writes no assets at all. Mock providers used *directly* — tests, `@vn/testkit`
— do emit **marked placeholder PNGs**, and a real backend refuses any reference carrying that
marker; see [`testkit.md`](testkit.md#placeholder-art-and-the-recorded-corpus).

## Project layout on disk

Authored input lives at the project root: `project.yaml`, `characters/<id>/character.md`,
`locations/<id>.md`, `scenes/<id>.md`. Those are the conventional homes, and where a _new_ sheet is
created — but a character or location tagged `type:` under `wiki/**` is discovered there too
([`plans/entity-discovery-by-meta-tag.md`](plans/entity-discovery-by-meta-tag.md)).

**Base art is the one generated thing that is not under `vngen/`.** `assets/` (`manifest.json` +
`objects/<hash>.<ext>`) sits at the project root because it is its own subtree and may be its own
repo — [`asset-stores.md`](asset-stores.md). Everything else generated lives under `vngen/`:

- `work/` — human-editable: the story graph, candidates, `approved.png`, `shots/<sceneId>.json`
- `build/` — machine: shot `assets/`, `manifest.json`
- `state/` — `tasks.jsonl`, reviews

In a user's own project `vngen/` is **committed**. It is the reproducible output of a run, not
something to gitignore. `examples/sample` is the one exception: it is a template this repo ships,
so it stays inputs-only.

### A scene is one file

`scenes/<id>.md` holds `scene: <id>` front-matter — identity and nothing else, matching the
filename — over a body that is a complete one-scene Fountain screenplay, heading and `[[…]]`
markers included. A directory has no document order, so the entry scene is `start:` in
`project.yaml`.

The older one-contended-file form (`screenplay/*.fountain`) is **not read**: a project holding one
and no `scenes/` gets an error naming `vngen import`, and one left beside chunks is a warning to
delete or rename it `.fountain.imported`. What a body may contain:
[`fountain.md`](fountain.md#where-the-fountain-lives-project-specific); why the reader is the only
thing that decides: [`pipeline-contracts.md`](pipeline-contracts.md#scenes-shots-and-lines).

## The sample project

[`examples/sample`](../examples/sample) is a small branching VN, and a **read-only template**: the
desktop app copies it rather than running in it (see
[`desktop-app.md`](desktop-app.md#seeded-workspace-examplesmysamplerepo)). The CLI has no such
indirection, so a real run against it writes generated art into the source tree — point it at a
copy if you want to keep `git status` legible.

Preview offline, then generate:

```sh
pnpm build
node apps/cli/dist/cli.js graph  examples/sample
node apps/cli/dist/cli.js run    examples/sample --mock      # dry run: previews planned work
# a real run needs a Gemini key (see above); it generates portraits, then halts at the gate:
node apps/cli/dist/cli.js run    examples/sample
node apps/cli/dist/cli.js approve examples/sample            # interactively approve portraits
node apps/cli/dist/cli.js run    examples/sample             # clears the gate, renders shots
node apps/cli/dist/cli.js status examples/sample
node apps/cli/dist/cli.js export examples/sample             # write the playable (story.play.json)
```
