# Pressure test — `plans/skills-editor-and-agent-authored-skills.md`

This document reads the skills-editor plan adversarially against the code as it stands
(August 2026). I re-derived every claim in the plan's "Verified ground truth" section from
the files that section cites, then looked for the write paths, refresh signals and
class-name contracts the plan does not mention.

Every claim in the ground truth holds, except for three line numbers that have drifted.
The plan names two stages as its riskiest (`selectionForNode` and `nodeIsSelected` default
silently where `menuFor` does not), and those two are the risky ones. The rest of this
section lists what breaks and what the plan leaves unsaid, ordered by how much work each
error moves.

<!-- toc -->

- [What checks out](#what-checks-out)
- [1. `skillWriteRefusal` is case-blind on both filesystems this app ships on](#1-skillwriterefusal-is-case-blind-on-both-filesystems-this-app-ships-on)
- [2. The Skills pane has no refresh wiring, and `edit_skill` has no `written`](#2-the-skills-pane-has-no-refresh-wiring-and-edit_skill-has-no-written)
- [3. The `dt-` → `tv-` rename collides with the three names the host still writes](#3-the-dt--%E2%86%92-tv--rename-collides-with-the-three-names-the-host-still-writes)
- [4. A resetless `treeview.css` inherits typography that only the host declares](#4-a-resetless-treeviewcss-inherits-typography-that-only-the-host-declares)
- [5. `git_restore` and `git_revert` still reach `.aiagent/skills/**`](#5-git_restore-and-git_revert-still-reach-aiagentskills)
- [6. `edit_skill` re-serializes a human's YAML, against the precedent one file over](#6-edit_skill-re-serializes-a-humans-yaml-against-the-precedent-one-file-over)
- [7. The two scaffolds are identical in what they write and opposite in when they refuse](#7-the-two-scaffolds-are-identical-in-what-they-write-and-opposite-in-when-they-refuse)
- [8. `skillId` is ASCII-only where this repo's own slug is not](#8-skillid-is-ascii-only-where-this-repos-own-slug-is-not)
- [9. Stage 0 lists the plan in the wrong index](#9-stage-0-lists-the-plan-in-the-wrong-index)
- [10. The end-to-end script asks the agent for a skill while it is in plan mode](#10-the-end-to-end-script-asks-the-agent-for-a-skill-while-it-is-in-plan-mode)
- [11. Smaller corrections](#11-smaller-corrections)
- [What survives](#what-survives)

<!-- tocstop -->

## What checks out

I tried hardest to break these parts and could not:

- `guardedDir` refuses only `scenes/` (`packages/store/src/docfile.ts`), so
  `.aiagent/skills/**` is already readable and writable through `doc.*`, and the Skills
  editor needs no new write path. This is the plan's central structural assumption, and it
  holds.
- **The compiler-catches table is right, including which two entries are not caught.**
  `menuFor` has no `default:` and a declared return type, so a seventh `DocNodeKind` is a
  compile error; `selectionForNode`, `nodeIsSelected` and `renameOf` each carry a
  `default:` and would silently do the wrong thing. `route.test.ts` declares a
  `Record<DocNodeKind, …>` twice, which gives the two further compile errors the plan
  relies on.
- **Claims tie-break on `EDITORS` order.** `routeFor` sorts by visibility, then tier, then
  `order`, and `CLAIMS` is `EDITORS.flatMap(…)`. Because `skills` is listed before `wiki`,
  a `SKILL.md` lands in the new pane instead of the wiki one.
- **`walkFiles`** returns paths relative to `dir`, applies `TREE_SKIP`, and throws on a
  missing directory, matching the description on all three points. Because it throws,
  `skillTree`'s `exists` guard is required rather than defensive.
- **Rejecting `workspace:filetree` for the pane is well argued.** `TREE_MAX_FILES = 5000`
  is a global cap on the whole walk, so a large project could exhaust it before reaching
  `.aiagent` at all. A separate channel is the only way the pane stays reliable.
- **`fileTree(paths, cap = DEFAULT_CAP)`** already takes a default, so adding a third
  default parameter is source-compatible with its one existing call. Reusing `file:<path>`
  ids makes selection highlighting work in the new pane without further changes.
- `writeFileAtomic` calls `ensureDir(dirname(path))`, so the scaffold's directory is
  created without the caller asking for it.
- **The wiki-extraction argument.** `drafts`, the `beforeunload` listener and the
  `seenHash` refusal are all at module scope in `wiki.ts`, so a second copy would install
  two listeners, and each listener would report the wrong `drafts.size`.
- **Six branches become seven** — `buildDocTree`'s own comment requires the new branch to
  go after Wiki and before Unapproved, because Unapproved is a lens on the same nodes and
  sits next to them.
- **The confirm card cannot be spoofed through `edit_skill`.** I went looking for this
  specifically. `runSkill`'s card is
  `Skill "${skill.id}" wants to run a script: ${skill.script}`. `id` is the directory name
  and `script` is the resolved absolute path, so neither is reachable from `edit_skill`'s
  patch. `.strict()` keeps a `script` key out before `run()` is entered. And the desktop
  agent is constructed with no `registry` (session.ts:766), so `doc.write` (the one path
  that could put a `run.mjs` on disk) is not in its 37 tools. These are three independent
  reasons, and the plan states only the second. State all three, because a reviewer will
  ask about this first.
- **The cut line is correct.** Stage 4 must stay. The counted double-click and the
  capture-phase dismiss latch are each about fifteen lines, and each carries a comment
  explaining why the obvious version fails, so a copy would carry the bugs those comments
  describe.

## 1. `skillWriteRefusal` is case-blind on both filesystems this app ships on

`rel` (packages/authoring/src/tools.ts:145) is `relative(root, abs).replace(/\\/g, '/')`,
so path separators are already normalised and the gate receives forward slashes, as the
plan states. Case is not normalised. `write_file('.AIAGENT/skills/x/run.mjs')` resolves to
the same directory on Windows and on default macOS, and a `startsWith('.aiagent/skills/')`
test does not match that path.

`guardedDir` has the identical weakness (`Scenes/greet.md` passes it), so there is
precedent for the sloppiness. But that guard only routes a write to a validated writer,
and losing the race writes an unvalidated scene. This guard makes the prose-only decision,
and the entire argument for that decision is that a confirm card cannot distinguish a
script vetted by a human from one the model asking to run it wrote ninety seconds ago.

Compare lowercased. The stage-1 test list refuses
`.aiagent/skills/x/{run.mjs,SKILL.md,lib/y.js}` and allows `characters/aiko/character.md`
and `.aiagent/config.json`. Add `.AIAGENT/skills/x/run.mjs` and a `..`-traversal case,
because a reader would assume both were already covered.

## 2. The Skills pane has no refresh wiring, and `edit_skill` has no `written`

Stage 8 specifies the header bar, the hint, the tree, the textarea, the footer and the
`ui.docPath` rule, and does not cover what reloads `workspace:skilltree`. Both comparable
panes hold two watchers. `wiki.ts` takes `onWrote` for the open document and
`onInvalidate` for the tree it draws from, and `documents.ts` takes `onInvalidate` for the
whole tree.

Without `onInvalidate(() => void this.loadTree())`, the Skills tree goes stale as soon as
a skill is added by the agent's `create_skill`, by a `doc.create kind='skill'`, or by an
undo. The acceptance step "confirm it appears in both trees on the next invalidation" then
has no mechanism on the Skills side.

The Documents half is fine, but not for the reason `onInvalidate`'s own doc comment
suggests. That comment describes the feed as mutating commands plus undo/redo, which would
exclude the agent entirely; in fact bridge.ts:263-275 also fires `wrote()` and
`invalidate()` from `agent:event` whenever `event.result.written` is non-empty. This has
two consequences:

- **`edit_skill` must return `written`, not just `create_skill`.** The stage-2 test list
  requires `create_skill` to report `written` forward-slashed and requires nothing of
  `edit_skill`, so nothing catches the gap. A description that an agent fixes does not
  appear in either tree until something else writes.
- That doc comment is stale, and worth a line while the area is open.

## 3. The `dt-` → `tv-` rename collides with the three names the host still writes

Stage 4 moves six rules — `.dt-rows`, `.dt-row`, `.dt-twisty`, `.dt-label`, `.dt-badge`,
`.dt-rename` — into `treeview.css` under a `tv-` prefix, and keeps in-place rename in
`DocumentsEditor`. But `beginRename` writes `box.className = 'dt-rename'` and finds its
label by `.dt-label`, and `this.rows = el('div', 'dt-rows')` is built in the host's
`init`. These three strings sit outside the function being extracted, in code the plan
explicitly leaves behind.

The plan is inconsistent here. It names `dataset.id` and `.tv-label` as renderer contract,
then lists `.dt-rename` among the rules that move, and `.dt-rename` is the one class the
extracted renderer never emits. Either the host's three strings change with the sheet, or
`.dt-rename` stays in `documents.css` beside its only writer. Choose one and state it. The
failure mode is an unstyled rename box, and no check catches it, because the stage-4 CDP
diff reads `className`, `title` and `paddingLeft` only.

## 4. A resetless `treeview.css` inherits typography that only the host declares

`documents.css` opens with a `* { box-sizing; margin; padding: 0 }` reset and sets
`font-family: var(--mono)`, `font-size: 12px` and `color: var(--paper)` on `.dt-surface`.
None of the six row rules sets those three properties. If those rows are adopted beside
`skills.css`, they render with whatever values `.sk-surface` declares.

Omitting the reset is the right call, because "its own class prefix, adopted beside the
host's sheet" requires it. The extraction therefore carries a contract: the tree's
typography belongs to the host. Stage 8's `.sk-surface` has to honour that contract
explicitly, or the two panes' trees diverge quietly in a way the before/after diff cannot
show.

## 5. `git_restore` and `git_revert` still reach `.aiagent/skills/**`

Both take an arbitrary path and are `mutating: true, confirm: true`. Their cards name the
path, which `run_skill`'s card does not, so a human approves a specific file coming back
from history. The operation is gated rather than open, and is probably fine.

The plan claims flatly that the agent may write `SKILL.md` and nothing else under
`.aiagent/skills/`, and that claim is false as written. A reviewer who finds these two
tools before the plan mentions them will reasonably stop trusting the rest of the threat
model. The honest fix is one clause that names both tools and states why their confirm
cards are adequate.

## 6. `edit_skill` re-serializes a human's YAML, against the precedent one file over

`renameInText` (apps/desktop/src/main/rename.ts) splices the `title:` line rather than
re-emitting, "because a wiki page's YAML is the author's and re-emitting it would reflow
keys they ordered." `edit_skill` merges its patch over `skill.raw` and hands the whole map
to `stringifyFrontMatter`, which reflows key order and drops comments — including a
comment above a hand-vetted `script:`. Preserving a key's value does not preserve the line
it was written on.

This is probably acceptable for a four-key machine-shaped front-matter. But the plan cites
preservation of a human's `script:` as the reason `edit_skill` exists at all, so it should
state why the weaker form of preservation is enough here and not for a wiki page.

## 7. The two scaffolds are identical in what they write and opposite in when they refuse

`writeSkill` refuses an existing directory unless told to overwrite.
`doc.create kind='skill'` goes through `checkDocWrite` with `seenHash: ''`, which refuses
an existing file. So for a directory holding a vetted `run.mjs` and no `SKILL.md`, the
human's scaffold is accepted and the agent's scaffold is rejected.

That is the right way round and worth keeping deliberately. Sharing `newSkillTemplate`
makes the two acts write the same content, but each still refuses under its own
conditions. Stage 9 currently claims the stronger thing.

## 8. `skillId` is ASCII-only where this repo's own slug is not

`slug` (packages/model/src/slug.ts) keeps `\p{Letter}\p{Number}`, so a non-Latin directory
name is already legal elsewhere in a project. The plan's `isSkillId` is
`/^[a-z0-9]+(?:-[a-z0-9]+)*$/` and its `skillId` collapses non-alphanumeric runs, so a
wholly non-Latin skill name slugs to the empty string and is refused. In a visual-novel
tool, such a name is not an exotic input.

The plan is right not to reuse `slug` outright, since it yields underscores and every
skill id in the repo is hyphenated. It should say whether the ASCII-only restriction is
deliberate or incidental, because the directory name ends up beside `argv` in an
`execFile`.

`edit_skill` resolves through `discoverSkills`, which reads whatever the directory is
actually called, so `isSkillId` gates creation only. An id that `isSkillId` would refuse
to mint remains editable. The asymmetry is correct, and stating it keeps it from reading
as an oversight.

## 9. Stage 0 lists the plan in the wrong index

docs/index.md says implementation plans live separately and that plans/index.md "lists all
of them with their build status". Plans are not listed individually at the docs/ root.
Stage 0 and the "Docs touched" list both name docs/index.md, but both mean
docs/plans/index.md. That file is also missing from the file list, and it carries no
status row for this plan today.

## 10. The end-to-end script asks the agent for a skill while it is in plan mode

loop.ts:245 reads `this.mode = opts.mode ?? 'plan'`, and the desktop session passes no
mode. So the agent starts read-only, and `create_skill` (`mutating: true` by the plan's
own stage 2) is blocked until a plan is proposed and approved. The acceptance line "ask
the agent for a skill and confirm it appears in both trees" reads as one step but is three
steps, and the hint button's tooltip should promise a plan rather than a file. (The
adjacent step has the same shape and is the more valuable of the two: ask for a skill
"that runs a script" and confirm the stage-2 refusal.)

## 11. Smaller corrections

- The line numbers have drifted, but the substance is unaffected. `ALWAYS_LOADED` is at
  `loop.ts:145` (the plan says 137), the `ctx.confirm` default that hard-codes
  `'run_skill'` is at `loop.ts:237-239` (says 228-233), `InvokeChannels` is at
  `ipc.ts:612` (says 621), `readSkill` is at `skills.ts:61-73` (says 62-74), and the
  `assetstrip.css` rule is at `:6-7` (says 5-7).
- `defaultExpanded`'s doc comment says "the five branches" and is already stale at six.
  Adding a seventh branch makes the comment more wrong; add the seventh to the list in the
  docs.
- The doc comment on `DocNode.badge` lists the allowed values: `unreachable`, `draft`,
  `mined`, `base`, `accepted`, `stale`. `script` is added to that list.
- Listing `skills` before `wiki` in `EDITORS` also reorders View ▸ Editors and the
  palette, since both read `EDITOR_IDS`. That reordering is harmless and is not mentioned
  elsewhere.
- The host can derive `RowLook.badBadge` from the node it already has. Carrying it as a
  callback field on the look object adds a field the seam does not need, and the plan
  otherwise keeps that seam narrow.
- Stage 8 does not budget the pane's own `expanded` set, or its
  `flattenTree`/`toggleExpanded` wiring. The tree holds state. The ~40-line estimate for
  holding `shown`/`seenHash`/`dirty` locally (in the cut-lines section) is separate from
  the `expanded` set.
- **The always-drawn empty branch is better motivated than the plan argues.** `skeleton()`
  writes the layout files, `.gitattributes`, `project.yaml`, one scene and
  `wiki/index.md`, so a created project has no `.aiagent/` at all. The branch is therefore
  empty for every project made in the app, and it is the only indication that skills
  exist. Only the seeded sample ships one, through `seedWorkspace`'s `SKIP` set
  (`vngen keys .git node_modules`), which lets `.aiagent` through.
- `.aiagent` is not in `DEFAULT_IGNORES` (`keys node_modules .DS_Store`), so the Save
  tooltip's "saves and commits" is accurate for a skill file. Stage 8 should state this,
  since a reader would doubt that claim.

## What survives

The architecture holds up. The plan picks the right seam in every case I checked:
`.aiagent/skills/**` is already inside `doc.*`'s write path, so the editor needs no new
one; the tree extraction is motivated by two genuinely subtle behaviours rather than by
line count; the separate `workspace:skilltree` channel is required by a global file cap
rather than chosen for tidiness; and the prose-only gate is enforced by `.strict()` on the
args, before `run()`, which is the one place a model cannot route around it.

All but one of the findings above are omissions rather than wrong turns. They are things
the plan does not say, in a plan whose distinguishing quality is how much it does say. The
exception is finding 1, which describes a real bypass on the two filesystems this app runs
on, and the plan's own test list would not catch it.
