# Skills editor, and skills the agent can write

This plan has been pressure-tested; the findings are folded in below, and the record of what was
checked is
[`../../research/pressure-test-skills-editor-plan.md`](../../research/pressure-test-skills-editor-plan.md).

## Context

`vnauthor` already has a skills system — `.aiagent/skills/<id>/SKILL.md`, front-matter
`name`/`description`/`when-to-use` plus an optional `script:`, discovered by `discoverSkills`
and offered to the agent through `discover_skills` / `run_skill`
(`packages/authoring/src/skills.ts`). Only one skill ships
(`templates/basic/.aiagent/skills/new-character/SKILL.md`).

Nothing in the desktop app knows skills exist. They are absent from the document tree, there is
no pane that edits them, and an author who has never read `docs/` has no way to discover the
feature at all — `search` cannot even see `.aiagent/` (`INPUT_GLOBS` is
`characters/ locations/ scenes/ screenplay/`), so the agent cannot stumble onto it either.

The outcome: a **Skills branch** in the document tree, a **Skills editor** with a tree over every
file under `.aiagent/skills` and a textarea to edit them, a **hint plus a button** that hands the
author to the agent, and the **agent tools** to write a skill on request.

Three decisions the user made, which the plan below assumes:

- **Prose only.** The agent may write `SKILL.md` and nothing else under `.aiagent/skills/`.
  Today it can `write_file('.aiagent/skills/x/run.mjs', <arbitrary node>)` and then `run_skill`,
  whose confirm card says only _"Skill "x" wants to run a script: …/run.mjs"_ — a sentence that
  reads identically whether a human vetted that file last year or the agent wrote it ninety
  seconds ago. Showing the body in the card turns a yes/no into a code review at the worst
  possible moment. Making the file unwritable removes the decision instead of delegating it.
  Script-bearing skills stay fully supported when a **person** writes them.
  Two paths survive the gate and are left open deliberately: `git_restore` and `git_revert` take
  an arbitrary path and could bring a deleted `run.mjs` back. Both are `confirm: true` and, unlike
  `run_skill`'s card, theirs **name the file**, so a person approves that specific resurrection —
  which is exactly the bar this decision sets. "Prose only" means the agent cannot **author** a
  script, not that no tool can move bytes.
- **The Skills branch is always drawn**, even with nothing under it — a deliberate break from the
  "empty means absent" convention (`docs/document-tree.md`), because skills are a feature that has
  to be found before it can be used, and an absent branch teaches nobody. It also keeps the branch
  heading's _New skill…_ / _Ask the agent for a skill…_ menu reachable in a project with none.
- **The hint is a sentence plus a button** that opens the `agent.run` dialog pre-filled.

## Verified ground truth

- `packages/store/src/docfile.ts:41` — `guardedDir` refuses **only** `scenes/`. So
  `.aiagent/skills/**` is already readable and writable by `doc.read`/`doc.write` **and** by the
  agent's `write_file`. The editor needs no new write path.
- `readSkill` degrades silently twice: a missing `name` becomes the directory id, a missing
  `description` becomes `''` (`skills.ts:61-73`). And `findScript` (`skills.ts:49-59`) falls
  through to the `run.mjs|run.js|run.cjs|run.sh` scan when front-matter `script:` names a file
  that does not exist — so a stale `run.mjs` silently runs instead.
- `create_character` (`tools.ts:511`) is the collision-refusal precedent, but it slugs with
  `packages/model/src/slug.ts`, which yields **underscores**. Every skill id in the repo is
  **hyphenated**. Mirror the shape of the call, not the function.
- `loop.ts:237-239` hard-codes the tool name `'run_skill'` when routing `ctx.confirm`, so any new
  tool using `ctx.confirm` renders in the desktop card as if it were `run_skill`. Nothing new
  should use it.
- `ALWAYS_LOADED` (`loop.ts:145`) is pinned to exactly six by `tests/loop.test.ts:700-733`, with a
  byte-identical-catalog test beside it. Not touching it.
- `apps/desktop` already depends on `@vn/authoring` (`package.json:24`, used at `session.ts:150`),
  so `discoverSkills` is available in main with no boundary change.
- `writeFileAtomic` calls `ensureDir(dirname)` (`packages/util/src/fs.ts:15`) — scaffolding
  `.aiagent/skills/<id>/SKILL.md` creates the directory for free.
- `PROJECT_SKILLS_DIR` is `join('.aiagent','skills')` — `.aiagent\skills` on Windows. Every
  workspace-relative path on the wire is forward-slashed, so it must never reach a `DocNode.path`.
- `apps/desktop/renderer/styles/assetstrip.css:6-7` states the shared-widget rule: an extracted
  widget uses **its own class prefix**, because it is adopted beside the host's sheet.
- `renameInText` (`src/main/rename.ts:44-58`) would write a front-matter `title:` for a skill file,
  which `readSkill` never reads — so a skill must not be renamable through the tree.
- `renderer/pathux/tests/route.test.ts` is exhaustive over `DocNodeKind` **twice** (`NODES` l.24,
  `WITH_NOTHING_OPEN` l.41). A new kind is a compile error there as well as in `menuFor`.
- **Agent writes do refresh the trees**, contrary to `onInvalidate`'s own doc comment
  (`renderer/pathux/bridge.ts:107-114`), which describes the feed as mutating commands plus
  undo/redo. `bridge.ts:263-275` also fires `wrote()` and `invalidate()` off `agent:event` — but
  **only when `event.result.written` is non-empty**. That makes `written` load-bearing for every
  new mutating tool, and the stale doc comment is fixed in stage 2.
- **`rel` (`tools.ts:145`) forward-slashes but does not case-fold.** Separators are handled;
  `.AIAGENT/…` is not. See `skillWriteRefusal` in stage 1.
- **The desktop agent starts in plan mode** — `this.mode = opts.mode ?? 'plan'` (`loop.ts:245`),
  and `session.ts:766` passes no mode — so a `mutating` skill tool is blocked until a plan is
  proposed and approved. That is the intended shape, not a defect; it is what the acceptance
  script has to walk through.
- **A created project has no `.aiagent/` at all.** `skeleton()`
  (`src/main/workspace.ts:275-296`) writes the layouts, `.gitattributes`, `project.yaml`, one
  scene and `wiki/index.md`. Only the seeded sample ships a skill, through `seedWorkspace`'s
  `SKIP` set (`vngen keys .git node_modules`), which lets `.aiagent` through. This is the
  strongest argument for the always-drawn branch: for every project made in the app it is empty
  on day one and is the only thing that says skills exist.
- **`.aiagent` is not in `DEFAULT_IGNORES`** (`keys node_modules .DS_Store`), so a skill file is
  tracked and commit-on-save applies to it — which is what makes the Save tooltip honest.

## Stage 0 — the plan document

`docs/plans/skills-editor-and-agent-authored-skills.md`, listed in
[`../index.md`](../index.md) with a status row — **not** `docs/index.md`, which delegates
plans to that file and lists only the `docs/` pages themselves.

---

# Part A — the agent can write a skill

## Stage 1 — the write half of the skills contract

`packages/authoring/src/skills.ts` — the writer must live beside `readSkill` or the two drift;
`readSkill` already uses `parseFrontMatter` from `@vn/parse`, whose `stringifyFrontMatter`
(`packages/parse/src/frontmatter.ts:37`) is the exact inverse and already a dependency. It also
lets the desktop scaffold produce byte-identical output to the agent's.

```ts
export const SKILL_FILE = 'SKILL.md';

/** Hyphenated skill id from a name; '' when nothing survives. */
export function skillId(name: string): string;
export function isSkillId(id: string): boolean;   // /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillInput { id, name, description, whenToUse?, body }

/** The canonical SKILL.md: fixed key order, plus preserved keys (e.g. a human's `script:`). */
export function skillDoc(input: SkillInput, preserve?: Record<string, unknown>): FrontMatterDoc;
export function newSkillTemplate(name: string): string;   // shared with doc.create, stage 9

export function writeSkill(
  root: string, input: SkillInput, opts?: { overwrite?: boolean },
): Promise<{ ok: true; id: string; file: string } | { ok: false; reason: string }>;

/** What `readSkill` degraded over, in the order a reader should fix them. */
export function skillIssues(skill: Skill): string[];

/**
 * Non-null when `write_file` must refuse this workspace-relative path.
 * Compares lowercased: `rel` forward-slashes but does not case-fold, and `.AIAGENT/skills/x`
 * is the same directory as `.aiagent/skills/x` on Windows and on default macOS.
 */
export function skillWriteRefusal(relPath: string): string | null;

export function readSkill(dir: string, id: string): Promise<Skill | null>;   // now exported
```

`skillId`: NFKD-normalize, non-alphanumeric runs → `-`, trim, lowercase, cap 64.
**ASCII-only, deliberately** — unlike `slug`, which keeps `\p{Letter}\p{Number}` and would accept
a non-Latin directory name. A skill id becomes a directory that a `run.mjs` is resolved against and
handed to `execFile`, so it stays in the portable set; a wholly non-Latin name slugs to `''` and is
refused with a message that says to give the skill a Latin id, not that the name is invalid. Note
the asymmetry this creates and keep it: `edit_skill` resolves through `discoverSkills`, which reads
whatever the directory is actually called, so `isSkillId` gates **creation only** and a
hand-made id it would refuse to mint stays editable.
`Skill` gains `raw: Record<string, unknown>` (parsed front-matter — what lets `edit_skill`
preserve keys it does not model) and `issues: string[]` (always present, often empty), both
populated by `readSkill`. `writeSkill` uses `writeFileAtomic` and refuses an existing directory
unless `overwrite`.

Tests — `packages/authoring/src/tests/skills.test.ts` (extend the existing `tempWorkspace`
harness): `skillId` cases including `"!!!" → ''`; `writeSkill` round-trips through
`discoverSkills`; the same input twice is byte-identical; collision refused, `overwrite` succeeds
and preserves an unmodeled key **and** `script:`; `skillIssues` for missing name, blank
description, empty body, and a `script:` naming a missing file with a `run.mjs` beside it;
`skillWriteRefusal` refuses `.aiagent/skills/x/{run.mjs,SKILL.md,lib/y.js}` **and
`.AIAGENT/Skills/x/run.mjs`** (the case bypass — the one test a reader would assume was already
there) **and `characters/../.aiagent/skills/x/run.mjs`**, and allows
`characters/aiko/character.md`, `.aiagent/config.json` and `characters/skills-notes.md`.

## Stage 2 — `create_skill`, `edit_skill`, and the `write_file` gate

`packages/authoring/src/tools.ts`:

```ts
const createSkillTool: Tool<{ name; description; whenToUse?; body; id? }>;  // args .strict()
const editSkillTool:   Tool<{ id; name?; description?; whenToUse?; body? }>; // args .strict()
```

Both `mutating: true`, neither `confirm`. `.strict()` is what shuts the script door: a `script`
argument is a parse error before `run()` is entered, and the descriptions say why in one line.

Three independent facts make `run_skill`'s confirm card unspoofable through these tools, and the
class doc should state all three, because it is the first thing a reviewer will try to break:
the card is ``Skill "${skill.id}" wants to run a script: ${skill.script}`` (`skills.ts:137`) where
`id` is the **directory name** and `script` the **resolved absolute path**, neither of which is in
`edit_skill`'s patch; `.strict()` keeps a `script` key out before `run()`; and the desktop agent is
built with no `registry` (`session.ts:766`), so `doc.write` — the one other path to a `run.mjs` —
is not among its tools.

**Both tools must return `written`.** `bridge.ts:263-275` invalidates the renderer's trees off
`agent:event` only when `event.result.written` is non-empty, so an `edit_skill` that reports
nothing leaves the Skills pane and the document tree showing the old description until something
else writes. Fix `onInvalidate`'s doc comment (`bridge.ts:107-114`) in the same commit — it claims
the feed is mutating commands plus undo/redo and has been wrong about the agent since it was
written.

`edit_skill` exists rather than "read + write is enough" because after the guard below
`write_file` **cannot** touch `.aiagent/skills/**`, and a label promising "ask the agent to write
one" means "and fix it"; also a whole-file rewrite drops front-matter keys the agent did not think
about, most dangerously a human's `script:`. It resolves through
`discoverSkills(skillRoots(...))` like `run_skill`, then **refuses when `skill.dir` is not under
`join(ctx.workspace.root, PROJECT_SKILLS_DIR)`** — `ctx.skillDirs` roots can point outside the
workspace — merges its patch over `skill.raw` and calls `writeSkill(…, { overwrite: true })`.

That is a **re-serialization**, and it goes deliberately against `renameInText`
(`src/main/rename.ts:59-61`), which splices a `title:` line rather than re-emitting "because a
wiki page's YAML is the author's and re-emitting it would reflow keys they ordered". The
difference is the document: a wiki page's front-matter is open-ended and hand-ordered, whereas a
`SKILL.md` has four known keys in a fixed order that `skillDoc` owns — so canonical output is the
point, not a cost. What re-emitting still loses is **comments**, including one above a human's
`script:`. Accepted, and said out loud in the tool description; if it bites, splice `script:` the
way `renameInText` splices `title:`.

`writeFileTool.run`, right after the `guardedDir` check:

```ts
const refusal = skillWriteRefusal(rel(ctx.workspace.root, abs));
if (refusal) return fail(refusal);
```

with the sentence: ``.aiagent/skills/ is written by `create_skill` and `edit_skill`, which write
prose only — a skill that runs a script has to be added by a person.``

`git_restore` and `git_revert` still take an arbitrary path and are **not** gated here — see the
Context note: both are `confirm: true` with the path in the card, which is the bar. Say so in the
`write_file` refusal's neighbouring comment so the next reader does not think it was missed.

`discover_skills` appends ` (!) ${skill.issues.join('; ')}` when non-empty and carries `issues` in
`data`, so a description the agent forgot stops being invisible. `run_skill`, `findScript`,
`SCRIPT_FILES` and the confirm gate are **unchanged**.

Insert both into `ALL_TOOLS` beside `discoverSkillsTool`/`runSkillTool`. The desktop Convo pane
needs no change — `session.ts:766` constructs `new Agent({…})` with no `registry`, so
`createRegistry()` picks them up.

Not adding `delete_skill`: deleting a directory is the editor's job and there is no delete tool in
`ALL_TOOLS` today.

Tests — `packages/authoring/src/tests/tools.test.ts` (first `describe('skills')` block there,
using the existing `tempProject`/`run` harness): `create_skill` writes the file, reports it
forward-slashed in `written`, and a following `discover_skills` lists it; refuses a collision with
a `create_character`-shaped message; refuses a name that slugs to nothing;
`tool('create_skill').args.safeParse({ …, script: 'run.mjs' }).success === false`; `edit_skill`
changes one field **and reports it in `written`**, refuses an unknown id, preserves a `script:`,
refuses a `ctx.skillDirs` skill;
`write_file` refuses both `.aiagent/skills/x/run.mjs` and `…/SKILL.md` and the refusal names
`create_skill`; `discover_skills` prints `(!)`; both tools are `mutating` and not `confirm`.

## Stage 3 — the prompt line and `docs/vnauthor.md`

One sentence in `SYSTEM_PROMPT` (`packages/authoring/src/context.ts:66`, beside the existing
skills line): skills are reusable playbooks under `.aiagent/skills/`, `discover_skills` lists them
(`search` does not reach them), `create_skill` writes one when the author asks for a repeatable
procedure, and skills you write are prose. This is a one-time cache-prefix invalidation, by design;
`tests/context.test.ts:24` is a tautological `toBe(SYSTEM_PROMPT)` and stays green.
**No `ALWAYS_LOADED` change** — it would cost the full schema on every request forever and break
the two catalog tests, to save one tool-search round trip on a path the author explicitly started.

`docs/vnauthor.md`: `37 tools` (l.125) → `39`; the Skills row gains `create_skill` **M** and
`edit_skill` **M**; the raw-write row and the "Two absences are deliberate" paragraph gain the
`.aiagent/skills/**` carve-out; the Skills section (l.309-315) gains a paragraph on
agent-authored skills and the prose-only rule.

---

# Part B — the desktop app

## Stage 4 — extract the tree renderer (no behaviour change)

`rowEl` in `renderer/pathux/editors/documents.ts:359-428` is the only DOM tree renderer and it is
private. It carries three things that rot in a copy: the **counted** double-click (a `dblclick`
listener cannot work, because the first click rebuilds the rows), the capture-phase dismiss latch,
and the "no row hovers silently" tooltip fallback. Extract, on the `assetstrip.ts` precedent —
a second host is exactly the trigger.

New `apps/desktop/renderer/pathux/treeview.ts` + `renderer/styles/treeview.css` (class prefix
`tv-`, **no** reset, matching `assetstrip.css`):

```ts
export const TREEVIEW_CSS: string;              // ../styles/treeview.css?inline
export const DOUBLE_CLICK_MS = 500;
export interface RowLook { selected: boolean; title: string }   // title never ''
export interface TreeHandlers {
  look(row: DocRow): RowLook;
  onToggle(id: string): void;
  onClick(row: DocRow): void;
  onSecondClick?(row: DocRow): void;
  onMenu?(row: DocRow, x: number, y: number): void;
}
export function renderTree(root: HTMLElement, rows: readonly DocRow[], h: TreeHandlers): void;
export interface ClickLatch { id: string; at: number }
export const NO_CLICK: ClickLatch;
export function countClick(last: ClickLatch, id: string, at: number): { again: boolean; next: ClickLatch };
export function armDismissLatch(surface: HTMLElement, menuIsOpen: () => boolean): void;
export function rowElementFor(root: HTMLElement, id: string): HTMLElement | undefined;
```

`RowLook` deliberately carries only what the **host** knows and the renderer cannot derive. The
badge's warning styling is a function of `row.node.badge`, which `renderTree` already has, so it
stays inside the renderer rather than becoming a third callback field on a seam this stage is
otherwise keeping narrow.

The tooltip **chain** is a rule about node kinds, not about the DOM, so it goes to
`renderer/pathux/doctree.ts` where the rest of the tree's rules already live and are tested:

```ts
/** What a row says on hover. The two facts the tree adds to the node are the arguments. */
export function rowTitle(node: DocNode, opts: { renamable: boolean; sheetless: boolean }): string;
```

Stays in `DocumentsEditor`: in-place rename (`beginRename` finds a row by `data-id` and swaps the
`.tv-label` — the renderer's doc comment states that `dataset.id` and `.tv-label` are contract),
the backlink panel, the `picked` latch, the `New…` row, the mode toggle, and
`menuFor`/`selectionForNode`/`renameOf`. The dismiss latch is still armed by the host on
`this.surface`, not `this.rows`, so it keeps covering the backlink panel.

The only intended diff is `dt-` → `tv-` for the six row-level rules (`.dt-rows`, `.dt-row`,
`.dt-twisty`, `.dt-label`, `.dt-badge`, `.dt-rename`) moving out of `documents.css`; everything
pane-shaped stays. Nothing in `docs/` or `scripts/` references those class names.

**Three of those names are written by host code the extraction leaves behind, and must be renamed
with the sheet or the rule silently stops applying:** `this.rows = el('div', 'dt-rows')` in
`init` (`documents.ts:100`), and `box.className = 'dt-rename'` plus the `.dt-label` lookup in
`beginRename` (`:543-546`). `renderTree` never emits `.dt-rename` at all — it belongs to rename,
which stays in the host — so it moves only because the row it covers moves. The failure mode is an
unstyled rename box, and the CDP diff below cannot see it: it reads `className`, `title` and
`paddingLeft` only. Grep `dt-` in `editors/documents.ts` after the extraction; it should return
nothing.

**`treeview.css` carrying no reset means the rows inherit their typography from the host**, which
is the intent but is currently unstated. `documents.css` opens with `* { box-sizing; margin;
padding: 0 }` and puts `font-family: var(--mono)`, `font-size: 12px` and `color: var(--paper)` on
`.dt-surface`; none of the six moved rules carries any of it. Say so in `treeview.css`'s header
comment, because it becomes a requirement on `.sk-surface` in stage 8 and the two panes' trees
diverge quietly if it is missed.

Tests — `renderer/pathux/tests/treeview.test.ts` (`countClick`: same id inside 500 ms is `again`
and resets the latch; a different id is not) and new `rowTitle` cases in the existing
`renderer/pathux/tests/doctree.test.ts` covering the whole chain from `documents.ts:389-401`.

## Stage 5 — extract the document buffer (no behaviour change)

`renderer/pathux/editors/wiki.ts` holds the `seenHash` content-refusal, the module-level draft map
and the `beforeunload` guard. Those are correctness, not looks — a drifted copy loses an author's
text silently, and two `beforeunload` listeners each report the wrong `drafts.size`. Unlike the
tree, this half has **no** host-specific behaviour to parameterise: both panes are literally
`doc.read` → textarea → `doc.write`.

New `renderer/pathux/docbuffer.ts`:

```ts
export interface DocIo { read(path); write(path, text, seenHash) }
export const BRIDGE_IO: DocIo;                  // exec('doc.read') / exec('doc.write')
export class DocBuffer {
  constructor(onChange: () => void, io?: DocIo);
  readonly path; readonly dirty; readonly note; readonly bad;
  text: string;                                 // setter marks dirty and stores the draft
  open(path): Promise<void>;                    // draft first, else doc.read; rising `token` guard
  reload(): Promise<void>;
  save(): Promise<boolean>;                     // seenHash refusal; clears the draft on success
  wrote(paths: readonly string[]): void;        // a clean buffer follows, a dirty one does not
}
export function draftCount(): number;
```

The `drafts` map and the `beforeunload` guard live here, once. `wiki.ts` loses ~90 lines. The `io`
constructor argument exists only so tests need no module mock (the desktop jest project is
node-only and `bridge.js` reaches `window` through `api.js`).

Tests — `renderer/pathux/tests/docbuffer.test.ts` over a fake `DocIo`: draft restored on reopen,
a stale read dropped by the token, save refused on a hash mismatch with the refusal kept in `note`,
`wrote()` follows a clean buffer and not a dirty one, `reload()` discards and says so.

## Stage 6 — the Skills branch in the document tree

One new `DocNodeKind`, leaves only:

```
Skills   branch:skills → skill:<id>
```

- `skill:<id>`, kind `skill`, label = the skill's `name`, `path` =
  `.aiagent/skills/<id>/SKILL.md`, `badge: 'script'` when it has one, `note` = its `description`
  (fallback: _"A playbook the agent can follow. Open it in the Skills pane."_).
- **No file children here.** The doc tree is identity, not content (`docs/document-tree.md`); a
  skill is one thing with an id, a name and a description, the same granularity as a character.
  The files are the Skills pane's tree.
- **Always drawn**, including empty — the user's decision, against the `unapprovedBranch`
  precedent. `docs/document-tree.md` gets the exception and its reason: skills must be findable
  before they exist, and the branch heading's menu is the only always-reachable way to make one.
  This is stronger than it first looks: `skeleton()` writes no `.aiagent/` at all, so **every**
  project created in the app has an empty branch on day one, and an absent one would mean the
  feature is invisible to exactly the authors who have not read `docs/`.
  Mechanically: `DocTreeInput.skills?` undefined → branch absent (every existing caller and test
  unchanged); an array, **including `[]`** → branch drawn.
- Placed after Wiki, before Unapproved assets, in `buildDocTree`'s `roots`
  (`src/main/doctree.ts:390-402`) — skills are authored input, and nothing may come between the two
  lenses on the manifest.

```ts
// src/main/doctree.ts — deliberately not @vn/authoring's `Skill`, which carries the whole body
// and absolute paths, neither of which belongs on the wire.
export interface SkillEntry { id; name; description; file /* rel, `/` */; script: boolean }
// DocTreeInput gains:  skills?: readonly SkillEntry[];   // exactly the `slots` precedent
```

```ts
// src/main/session.ts
/** The project's skills, as the tree needs them. One `discoverSkills` per doc-tree read. */
private async skillEntries(): Promise<SkillEntry[]>;   // discoverSkills(skillRoots(this.dir)), relPath for `file`
```

Every touch point for `+ 'skill'`:

| Where                                     | Compiler catches it | What to write                                                             |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `src/shared/ipc.ts:375` `DocNodeKind`     | —                   | the union member + one doc line                                           |
| `src/shared/ipc.ts:405` `DocNode.badge`   | no                  | `script` joins the enumerated vocabulary in its doc comment              |
| `renderer/pathux/doctree.ts:51-55`        | no                  | `defaultExpanded` says "the five branches"; already stale at six         |
| `renderer/pathux/doctree.ts` `menuFor`    | **yes** (no default)| _Open in the Skills pane_ · _Ask the agent to change this skill…_         |
| …`selectionForNode`                       | no (has default)    | `case 'skill'` beside `location`/`wiki`/`file`: sets `docPath`            |
| …`nodeIsSelected`                         | no (has default)    | `case 'skill'` compares `node.path`                                       |
| …`renameOf`                               | no (has default)    | **leave out, and say why** — `renameInText` would write an unread `title:`|
| `src/shared/editors.ts`                   | no                  | the new `skills` entry's `claims` (stage 8)                               |
| `renderer/pathux/route.ts` `SUBJECT_OF`   | no                  | `skills: 'docPath'` (stage 8)                                             |
| `renderer/pathux/tests/route.test.ts`     | **yes ×2**          | `NODES.skill` and `WITH_NOTHING_OPEN.skill`                               |
| `renderer/api.ts` `MOCK_DOCTREE`          | no                  | a skills branch, so the browser preview draws one                         |

The two silent ones (`selectionForNode`, `nodeIsSelected`) are this stage's risk and are covered by
the tests below.

Tests — `src/main/tests/doctree.test.ts`: absent without `skills`, **drawn with `[]`**, label from
`name`, `script` badge, `note` from `description` and its fallback, path forward-slashed on
Windows, cap. `renderer/pathux/tests/doctree.test.ts`: `menuFor`, `selectionForNode`,
`nodeIsSelected` for a `skill`, and `renameOf` returning `undefined`. Docs:
`docs/document-tree.md` — seven branches, the menu table, the `renameOf` paragraph, "Where it
lives", and the always-drawn exception.

## Stage 7 — the skills file tree (a new channel)

**Not** a filtered `workspace:filetree`: `walkFiles` is capped at `TREE_MAX_FILES = 5000` across
the whole project, so on a big project `.aiagent` can be truncated away and the pane would show an
empty directory with no explanation; it also ships the whole project's file list to draw a dozen
rows, and makes the pane depend on the sidebar's walk budget.

```ts
// src/main/doctree.ts — ids and paths carry `prefix`; structure still comes from `paths`.
export function fileTree(paths: readonly string[], cap?: number, prefix?: string): DocNode[];

// src/main/session.ts
/** Every file under `.aiagent/skills`, as the Skills pane's tree. Empty when there is no such dir. */
async skillTree(): Promise<DocNode[]>;   // fileTree(await walkFiles(skillsDir), DEFAULT_CAP, '.aiagent/skills/')
```

`walkFiles` already returns paths relative to `dir` and already applies `TREE_SKIP`, so a
`node_modules` inside a skill is skipped — but it **rejects on a missing directory**, so
`skillTree` guards with `exists` and returns `[]`. `prefix` is a default parameter, so the existing
call and tests are untouched; ids become `file:.aiagent/skills/<id>/SKILL.md`, which is what makes
`selectionForNode`/`nodeIsSelected` work in the pane with **no new code**, and `defaultExpanded`
opens each skill directory with no extra rule because the pane's roots are the skill dirs.

Wiring: `'workspace:skilltree': () => DocNode[]` in `InvokeChannels` (`src/shared/ipc.ts:612`),
`handle(...)` in `src/main/index.ts:474`, a `workspace.skilltree` command in
`src/main/commands/workspace.ts` registered in `commands/index.ts` (mirroring `workspace.filetree`
— that is how the shape gets debugged over CDP before the pane exists), and `MOCK_SKILLTREE` in
`renderer/api.ts`. The preload is a generic pass-through and needs nothing.

Tests — `src/main/tests/doctree.test.ts`: the prefix on ids and paths, structure taken from the
unprefixed path, dirs before files; plus one end-to-end case over a real temp workspace (the
pattern already at the bottom of that file), including the missing-directory `[]`.

## Stage 8 — the Skills editor

```
header row:   SKILLS   [Save]  [⟳]                    (path.ux, exactly wiki.ts's bar)
.sk-surface
  .sk-hint    "A skill is a playbook the agent can follow — and can write."
              [ Ask the agent for a skill… ]          → openCommandDialog('agent.run', {input})
  .sk-body    (flex row)
     .sk-tree   flex 0 0 220px   → renderTree(…)   ·  "No skills yet." when the walk is empty
     .sk-text   flex 1 1 auto    → <textarea>       (DocBuffer)
  .sk-foot    path · unsaved badge · note
```

The hint is **always visible and above the tree** — an empty pane is exactly when it is needed.
Its button is `openCommandDialog('agent.run', { input: NEW_SKILL_PROMPT })`
(`renderer/pathux/dialog.ts:97`), not `exec`: `agent.run` is mutating, and the dialog is where the
author finishes the sentence before anything runs. `NEW_SKILL_PROMPT` ends mid-sentence
(`'… It should: '`) so the form opens on a blank to fill.

Tooltips (the repo rule — every interactive element, and a disabled control's tooltip is its
refusal): the button, _"Open the agent form with a request for a new skill — you say what it should
do"_; the textarea, _"Edit this file as text. Ctrl+S saves and commits."_; a disabled Save,
_"Nothing to save"_. The commit half of that sentence is true and worth checking once: `.aiagent`
is not in `DEFAULT_IGNORES` (`keys node_modules .DS_Store`), so a skill file is tracked and
commit-on-save applies. The button's tooltip promises **the agent form**, not a file — `agent.run`
starts a plan-first turn (see stage 2), so what the author gets back first is a proposed plan.

Deliberately **not** reused: `renderAssetStrip` — nothing in the manifest binds to a skill file and
nothing ever will, so a strip would be permanently empty. Say so in the class doc.

**Two watchers, on the `wiki.ts:120-130` precedent — without them the pane is stale the moment
anything writes a skill** (`create_skill` from the Convo pane, `doc.create kind='skill'` from the
tree, an undo):

```ts
this.unwatch     = onWrote((paths) => this.buffer.wrote(paths));   // DocBuffer, stage 5
this.unwatchTree = onInvalidate(() => void this.loadTree());       // workspace:skilltree
```

Both are disposed in `on_destroy`. `onInvalidate` is what covers the agent, via
`bridge.ts:263-275` — which is why stage 2 makes `edit_skill` return `written`.

The tree is **not** stateless: the pane owns its own `expanded: Set<string>` seeded from
`defaultExpanded(roots)`, plus the `flattenTree`/`toggleExpanded` calls that turn it into
`DocRow[]`, exactly as `documents.ts` does. Budget it here; it is not part of `DocBuffer` and not
part of `renderTree`.

`.sk-surface` must declare `font-family: var(--mono)`, `font-size: 12px` and `color: var(--paper)`
and its own box-sizing reset — `treeview.css` carries none of it by design (stage 4), so the rows
render at whatever the host says and nothing warns when the host says nothing.

The pane follows `ui.docPath` **only when it points under `.aiagent/skills/`** (a wiki note
selected elsewhere must not blank it), and publishes `ui.docPath` on its own tree clicks. No
remembered fields — its subject is the shared selection — so
`registerEditor(SkillsEditor, 'vn.SkillsEditor')` takes no field list.

New files: `renderer/rules/skills.ts` (pure, beside `assetview.ts`) with `SKILLS_DIR =
'.aiagent/skills'` (forward-slashed, **not** `PROJECT_SKILLS_DIR`), `underSkills`, `skillIdOf`,
`NEW_SKILL_PROMPT`; `renderer/pathux/editors/skills.ts`; `renderer/styles/skills.css`; the
side-effect import in `shell.ts` between `script.js` and `tasks.js`.

Claims in `src/shared/editors.ts`: `skill` → `primary`, and `file` under `.aiagent/skills/` →
`primary` so a skill file clicked in **file** mode also lands here. That second one **ties with
Wiki** (`isTextPath('.md')` is primary), and the tie breaks on `EDITORS` order — so the `skills`
entry is listed **before** `wiki`, and the doc says why. The visibility-first rule still applies
and is correct: with Wiki up and Skills closed, a click lands in Wiki, where the author is looking.

Tests — `renderer/pathux/tests/skills.test.ts`: `underSkills`, `skillIdOf` (including `''` outside),
`NEW_SKILL_PROMPT` naming `.aiagent/skills` and the three front-matter keys; plus the two
`route.test.ts` records (`skill → 'skills'`). `editorNameProblems` is the boot gate that the
`EDITORS` id and the registered `areaname` agree. Docs: a `## Skills` section in
`docs/desktop-app.md` between Wiki and Documents, and a `skill` row in its claims table.

## Stage 9 — `doc.create` learns a `skill` kind

Extend rather than add a `skill.*` namespace: `doc.create` already means "scaffold a document from
a name in its conventional home, refusing rather than overwriting", `checkDocWrite` already permits
the path, and `writeFileAtomic` already makes the directory. A new namespace would need its own
preview, refusals and undo record for no new rule.

- `newSkillTemplate(name)` from stage 1 — shared, the same argument that keeps
  `newCharacterTemplate` shared, so the human's scaffold and the agent's write **byte-identical
  text**. They are not identical in **when they refuse**, and that difference is deliberate:
  `writeSkill` refuses an existing *directory*, while `doc.create` goes through `checkDocWrite`
  with `seenHash: ''` and refuses an existing *file*. So a directory holding a human's vetted
  `run.mjs` and no `SKILL.md` accepts the author's scaffold and rejects the agent's — the right way
  round, and a case worth a test rather than a comment.
- `NewDocKind += 'skill'` (`session.ts:521`) and a branch in `WorkspaceSession.newDoc` returning
  `{ id: skillId(name), path: '.aiagent/skills/<id>/SKILL.md', text: newSkillTemplate(name) }`.
- `NEW_DOC_KINDS += 'skill'` in `src/main/commands/doc.ts`, description updated.
- `newSheet`'s union in `renderer/pathux/doctree.ts`, and the Documents pane's `New…` select
  (`documents.ts:277`).
- `branch:skills` right-click, both `form: true` because the menu cannot supply the name or the
  sentence: _New skill…_ → `doc.create { kind: 'skill' }`; _Ask the agent for a skill…_ →
  `agent.run { input: NEW_SKILL_PROMPT }`.
- **No rename** (stage 6) and **no delete** — there is no `doc.delete`, and deleting a skill is
  deleting a directory; that route is the agent, behind its permission gate.

Tests — `packages/authoring/src/tests/skills.test.ts`: `discoverSkills` reads back what
`newSkillTemplate` writes (name, description, when-to-use round-trip).
`src/main/tests/session.test.ts`: `previewCreate('skill', …)` lands at the right path, refuses
over an existing `SKILL.md`, and **succeeds into a directory that holds only a `run.mjs`** — the
asymmetry above, asserted rather than assumed.

---

## Verification

Every stage is its own green commit — `pnpm check` **and** `pnpm check:renderer`, `pnpm test`,
`pnpm lint` — and tests live in a `tests/` sibling or they never run.

```sh
pnpm exec jest --selectProjects @vn/authoring     # stages 1-3, 9
pnpm exec jest --selectProjects @vn/desktop       # stages 4-9 (node-only: pure logic only)
pnpm check && pnpm check:renderer && pnpm test && pnpm lint
```

Surfaces are verified live over CDP. The pane mounts into a shadow root, so
`document.querySelectorAll` finds nothing — walk `.shadowRoot`. Split dispatch from assertion, and
never `await`:

```sh
pnpm vndesktop

# Stage 4 — the extraction changed nothing. Run before and after; diff the two.
node scripts/vn-cdp.mjs --raw "(()=>{const q=(r,s,o=[])=>{[...r.querySelectorAll('*')].forEach(e=>{if(e.matches(s))o.push(e);if(e.shadowRoot)q(e.shadowRoot,s,o)});return o};const rows=q(document,'.tv-row,.dt-row');return JSON.stringify({n:rows.length,first:rows.slice(0,6).map(r=>[r.className,r.title,r.style.paddingLeft])})})()"

# Stages 6/7 — the shapes, before any pane exists.
node scripts/vn-cdp.mjs "workspace.doctree()"   | grep -c 'branch:skills'
node scripts/vn-cdp.mjs "workspace.skilltree()"

# Stage 8 — open the pane, then read it. Two evaluations, never one.
node scripts/vn-cdp.mjs "view.open(editor=skills where=elsewhere)"
node scripts/vn-cdp.mjs --raw "(()=>{const q=(r,s,o=[])=>{[...r.querySelectorAll('*')].forEach(e=>{if(e.matches(s))o.push(e);if(e.shadowRoot)q(e.shadowRoot,s,o)});return o};return JSON.stringify({rows:q(document,'.tv-row').length,hint:q(document,'.sk-hint').length,text:q(document,'.sk-text').length,untitled:q(document,'.tv-row').filter(r=>!r.title).length})})()"
```

`untitled` must be `0` — that is the tooltip rule, asserted rather than eyeballed. Poll with a
deadline rather than sleeping; the surface settles a beat behind the store.

End-to-end, by hand: open the template project (which has one skill); confirm the Skills branch
lists it; click it and confirm the Skills pane opens with `SKILL.md` in the textarea; edit, Ctrl+S,
and confirm the commit; press _Ask the agent for a skill…_ and confirm the `agent.run` dialog opens
pre-filled; ask the agent for a skill, **approve the plan it proposes** — `create_skill` is
`mutating`, and the agent starts read-only (`loop.ts:245`), so this is three steps, not one — and
confirm the skill appears in **both** trees without touching either pane, which is the stage-8
`onInvalidate` wiring being exercised rather than eyeballed; ask it for a skill "that runs a
script" and confirm it refuses with the stage-2 sentence rather than writing one; then, with the
Skills pane open on a skill, edit that skill's description from the Convo pane and confirm the
textarea follows — that is `edit_skill`'s `written` doing its job.

## Docs touched

`docs/plans/skills-editor-and-agent-authored-skills.md` (new) · `docs/plans/index.md` (the status
row — **not** `docs/index.md`, which lists only `docs/` pages) · `docs/research/pressure-test-skills-editor-plan.md`
(already filed, and listed in `docs/index.md`) · `docs/document-tree.md` · `docs/desktop-app.md` ·
`docs/vnauthor.md` · `CLAUDE.md` (the twelve editors become thirteen; a line for the prose-only
rule) · then `pnpm exec prettier --check <the files touched>` rather than a blanket `pnpm lint`.
Run `pnpm markdown-toc` only if a page here gains or loses a heading, and check its diff before
committing: it walks the whole repo and will reformat `todos.md`, which is hand-written and
deliberately outside prettier's idea of markdown.

## Cut lines, if the plan is too large

Stage 5 (`DocBuffer`) is the one to drop — the Skills pane can hold `shown`/`seenHash`/`dirty`
itself in ~40 lines, at the cost of a second draft map and a second `beforeunload` listener. Not
recommended, but it is the only stage whose removal costs nothing else. Stage 4 is **not** a cut
line: without it the counted double-click and the dismiss latch are copied, bugs and all.
