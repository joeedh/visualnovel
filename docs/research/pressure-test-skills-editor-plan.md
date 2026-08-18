# Pressure test — `plans/skills-editor-and-agent-authored-skills.md`

An adversarial read of the skills-editor plan against the code as it stands (August 2026). Every
claim in its "Verified ground truth" section was re-derived from the files it cites, and then I went
looking for the write paths, refresh signals and class-name contracts it does not mention.

The ground truth holds — all of it, modulo three line numbers that have drifted. The two stages the
plan calls out as its own riskiest (`selectionForNode` and `nodeIsSelected` defaulting silently
where `menuFor` does not) are exactly the two that are risky. What follows is what breaks or is
left unsaid, ordered by how much work the error moves.

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

The parts I tried hardest to break and could not:

- **`guardedDir` really does refuse only `scenes/`** (`packages/store/src/docfile.ts`), so
  `.aiagent/skills/**` is already readable and writable through `doc.*` and the Skills editor needs
  no new write path. This is the plan's central structural bet and it is sound.
- **The compiler-catches table is right, including which two entries are not caught.** `menuFor`
  has no `default:` and a declared return type, so a seventh `DocNodeKind` is a compile error;
  `selectionForNode`, `nodeIsSelected` and `renameOf` each carry a `default:` and would silently do
  the wrong thing. `route.test.ts` is `Record<DocNodeKind, …>` twice, so that is two more compile
  errors the plan correctly banks on.
- **The claim tie-break is `EDITORS` order.** `routeFor` sorts visibility → tier → `order`, and
  `CLAIMS` is `EDITORS.flatMap(…)` — so listing `skills` before `wiki` is the entire mechanism by
  which a `SKILL.md` lands in the new pane instead of the wiki one.
- **`walkFiles`** returns paths relative to `dir`, applies `TREE_SKIP`, and throws on a missing
  directory — all three as described, so `skillTree`'s `exists` guard is load-bearing rather than
  defensive.
- **Rejecting `workspace:filetree` for the pane is well argued.** `TREE_MAX_FILES = 5000` is a
  global cap on the whole walk, so a large project could exhaust it before reaching `.aiagent` at
  all — a separate channel is not duplication, it is the only way the pane is reliable.
- **`fileTree(paths, cap = DEFAULT_CAP)`** already takes a default, so adding a third default
  parameter is source-compatible with its one existing call; and reusing `file:<path>` ids is
  genuinely what gets selection highlighting in the new pane for free.
- **`writeFileAtomic` calls `ensureDir(dirname(path))`**, so the scaffold gets its directory
  without asking.
- **The wiki-extraction argument.** `drafts`, the `beforeunload` listener and the `seenHash`
  refusal are all at module scope in `wiki.ts`; a second copy really would install two listeners
  each reporting the wrong `drafts.size`.
- **Six branches → seven, after Wiki and before Unapproved** — which `buildDocTree`'s own comment
  requires, since Unapproved is a lens on the same nodes and sits next to them.
- **The confirm card cannot be spoofed through `edit_skill`.** I went looking for this specifically.
  `runSkill`'s card is ``Skill "${skill.id}" wants to run a script: ${skill.script}`` — `id` is the
  directory name and `script` is the *resolved absolute path*, so neither is reachable from
  `edit_skill`'s patch; `.strict()` keeps a `script` key out before `run()` is entered; and the
  desktop agent is constructed with no `registry` (`session.ts:766`), so `doc.write` — the one path
  that could put a `run.mjs` on disk — is not in its 37 tools. Three independent reasons, and the
  plan states only the second. Say all three: it is the first question a reviewer will ask.
- **The cut line is correct.** Stage 4 is not droppable: the counted double-click and the
  capture-phase dismiss latch are each about fifteen lines with a comment explaining why the obvious
  version fails, and a copy would carry the bugs those comments describe.

## 1. `skillWriteRefusal` is case-blind on both filesystems this app ships on

`rel` (`packages/authoring/src/tools.ts:145`) is
`relative(root, abs).replace(/\\/g, '/')`, so the plan is right that path separators are already
normalised and the gate sees forward slashes. Case is not normalised.
`write_file('.AIAGENT/skills/x/run.mjs')` resolves to the same directory on Windows and on default
macOS, and a `startsWith('.aiagent/skills/')` test does not see it.

`guardedDir` has the identical weakness — `Scenes/greet.md` walks past it — so there is precedent
for the sloppiness. But that guard only routes a write to a validated writer, and losing the race
costs an unvalidated scene. This one **is** the prose-only decision, and the entire argument for
that decision is that a confirm card cannot tell a script vetted by a human from one written ninety
seconds ago by the model asking to run it.

Compare lowercased. The stage-1 test list is `.aiagent/skills/x/{run.mjs,SKILL.md,lib/y.js}`
refused and `characters/aiko/character.md` plus `.aiagent/config.json` allowed; add
`.AIAGENT/skills/x/run.mjs` and a `..`-traversal case, because those are the two a reader would
assume were already covered.

## 2. The Skills pane has no refresh wiring, and `edit_skill` has no `written`

Stage 8 specifies the header bar, the hint, the tree, the textarea, the footer and the `ui.docPath`
rule, and never says what reloads `workspace:skilltree`. Both comparable panes hold two watchers:
`wiki.ts` takes `onWrote` for the open document and `onInvalidate` for the tree it draws from, and
`documents.ts` takes `onInvalidate` for the whole tree.

Without `onInvalidate(() => void this.loadTree())` the Skills tree is stale the moment anything adds
a skill — the agent's `create_skill`, a `doc.create kind='skill'`, an undo — and the acceptance
step "confirm it appears in both trees on the next invalidation" has no mechanism at all on the
Skills side.

The Documents half is fine, but not for the reason `onInvalidate`'s own doc comment suggests. That
comment describes the feed as mutating commands plus undo/redo, which would exclude the agent
entirely; in fact `bridge.ts:263-275` also fires `wrote()` and `invalidate()` from `agent:event`
whenever `event.result.written` is non-empty. Two consequences:

- **`edit_skill` must return `written`, not just `create_skill`.** The stage-2 test list asks
  `create_skill` to report it forward-slashed and asks nothing of `edit_skill`, so the gap ships
  silently: an agent-fixed description that does not appear in either tree until something else
  writes.
- That doc comment is stale, and worth a line while the area is open.

## 3. The `dt-` → `tv-` rename collides with the three names the host still writes

Stage 4 moves six rules — `.dt-rows`, `.dt-row`, `.dt-twisty`, `.dt-label`, `.dt-badge`,
`.dt-rename` — into `treeview.css` under a `tv-` prefix, and keeps in-place rename in
`DocumentsEditor`. But `beginRename` writes `box.className = 'dt-rename'` and finds its label by
`.dt-label`, and `this.rows = el('div', 'dt-rows')` is built in the host's `init` — three strings
written outside the function being extracted, by code the plan explicitly leaves behind.

The plan half-sees this: it names `dataset.id` and `.tv-label` as renderer contract. Then it lists
`.dt-rename` among the rules that move, which is the one class the extracted renderer never emits.
Either the host's three strings change with the sheet, or `.dt-rename` stays in `documents.css`
beside its only writer. Pick one and say so — the failure mode is an unstyled rename box, and
nothing catches it: the stage-4 CDP diff reads `className`, `title` and `paddingLeft` only.

## 4. A resetless `treeview.css` inherits typography that only the host declares

`documents.css` opens with a `* { box-sizing; margin; padding: 0 }` reset and puts
`font-family: var(--mono)`, `font-size: 12px` and `color: var(--paper)` on `.dt-surface`. None of
the six row rules carries any of it. Adopted beside `skills.css`, those rows render at whatever
`.sk-surface` happens to say.

"No reset" is the right call — it is what "its own class prefix, adopted beside the host's sheet"
has to mean. But it makes *the tree's typography belongs to the host* a contract of the extraction,
and stage 8's `.sk-surface` has to honour it explicitly or the two panes' trees quietly diverge in
a way the before/after diff cannot see.

## 5. `git_restore` and `git_revert` still reach `.aiagent/skills/**`

Both take an arbitrary path and are `mutating: true, confirm: true`, and unlike `run_skill`'s card
theirs name the path — so a human approves a specific file coming back from history. Gated, not
open, and probably fine.

But the plan's flat claim — the agent may write `SKILL.md` and nothing else under
`.aiagent/skills/` — is false as written, and a reviewer who finds these two before the plan
mentions them will reasonably stop trusting the rest of the threat model. One clause naming both
tools and why their confirm cards are adequate closes it honestly.

## 6. `edit_skill` re-serializes a human's YAML, against the precedent one file over

`renameInText` (`apps/desktop/src/main/rename.ts`) splices the `title:` line rather than
re-emitting, "because a wiki page's YAML is the author's and re-emitting it would reflow keys they
ordered." `edit_skill` merges its patch over `skill.raw` and hands the whole map to
`stringifyFrontMatter`, which reflows key order and drops comments — including a comment above a
hand-vetted `script:`. Preserving that key's *value* is not the same as preserving its *line*.

Probably acceptable for a four-key machine-shaped front-matter. But the plan cites preservation of
a human's `script:` as the reason `edit_skill` exists at all, so it owes a sentence on why the
weaker form of preservation is enough here and not for a wiki page.

## 7. The two scaffolds are identical in what they write and opposite in when they refuse

`writeSkill` refuses an existing **directory** unless told to overwrite. `doc.create kind='skill'`
goes through `checkDocWrite` with `seenHash: ''`, which refuses an existing **file**. So a directory
holding a vetted `run.mjs` and no `SKILL.md` accepts the human's scaffold and rejects the agent's.

That is the right way round and worth keeping deliberately. It just means sharing
`newSkillTemplate` makes the two acts identical in what they write, not in when they refuse — and
stage 9 currently claims the stronger thing.

## 8. `skillId` is ASCII-only where this repo's own slug is not

`slug` (`packages/model/src/slug.ts`) keeps `\p{Letter}\p{Number}`, so a non-Latin directory name is
already legal elsewhere in a project. The plan's `isSkillId` is `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` and
its `skillId` collapses non-alphanumeric runs, so a wholly non-Latin skill name slugs to the empty
string and is refused — in a visual-novel tool, which is not an exotic input.

The plan is right not to reuse `slug` outright (it yields underscores; every skill id in the repo is
hyphenated). It should say whether ASCII-only is deliberate — a directory name that ends up beside
`argv` in an `execFile` — or incidental.

Worth stating too: `edit_skill` resolves through `discoverSkills`, which reads whatever the
directory is actually called, so `isSkillId` gates *creation* only. An id it would refuse to mint
remains editable. That asymmetry is correct; left unstated it reads as an oversight.

## 9. Stage 0 lists the plan in the wrong index

`docs/index.md` says implementation plans live separately and that `plans/index.md` "lists all of
them with their build status" — plans are not listed individually at the `docs/` root. Stage 0 and
the "Docs touched" list both name `docs/index.md`; both mean `docs/plans/index.md`, which is also
missing from the file list, and the plan has no status row in it today.

## 10. The end-to-end script asks the agent for a skill while it is in plan mode

`this.mode = opts.mode ?? 'plan'` (`loop.ts:245`), and the desktop session passes no mode. So the
agent starts read-only, and `create_skill` — `mutating: true` by the plan's own stage 2 — is
blocked until a plan is proposed and approved. The acceptance line "ask the agent for a skill and
confirm it appears in both trees" reads as one step and is three, and the hint button's tooltip
should promise a plan rather than a file. (The adjacent step — ask for a skill "that runs a script"
and confirm the stage-2 refusal — has the same shape, and is the more valuable of the two.)

## 11. Smaller corrections

- Line drift, substance unaffected: `ALWAYS_LOADED` is `loop.ts:145` (plan says 137), the
  `ctx.confirm` default that hard-codes `'run_skill'` is `loop.ts:237-239` (says 228-233),
  `InvokeChannels` is `ipc.ts:612` (says 621), `readSkill` is `skills.ts:61-73` (says 62-74), and
  the `assetstrip.css` rule is `:6-7` (says 5-7).
- `defaultExpanded`'s doc comment says "the five branches" and is already stale at six. The seventh
  makes it worse; add it to the docs list.
- `DocNode.badge`'s doc comment enumerates its vocabulary — `unreachable`, `draft`, `mined`, `base`,
  `accepted`, `stale`. `script` joins that list.
- Listing `skills` before `wiki` in `EDITORS` also reorders View ▸ Editors and the palette, since
  both read `EDITOR_IDS`. Harmless, and unmentioned.
- `RowLook.badBadge` is derivable from the node the host already has; carrying it as a callback
  field on the look object is redundant surface on a seam the plan is otherwise careful to keep
  narrow.
- Stage 8 does not budget the pane's own `expanded` set, or its `flattenTree`/`toggleExpanded`
  wiring — the tree is not stateless, and the ~40-line estimate for holding `shown`/`seenHash`/
  `dirty` locally (in the cut-lines section) is separate from this.
- **The always-drawn empty branch is better motivated than the plan argues.** `skeleton()` writes
  the layout files, `.gitattributes`, `project.yaml`, one scene and `wiki/index.md` — there is no
  `.aiagent/` at all in a *created* project. So for every project made in the app the branch is
  empty on day one and is the only thing that says skills exist. Only the seeded sample ships one,
  through `seedWorkspace`'s `SKIP` set (`vngen keys .git node_modules`), which lets `.aiagent`
  through.
- `.aiagent` is not in `DEFAULT_IGNORES` (`keys node_modules .DS_Store`), so the Save tooltip's
  "saves and commits" is honest for a skill file. Worth a line in stage 8, since it is the claim a
  reader would doubt.

## What survives

The architecture. The plan picks the right seam in every case I checked: `.aiagent/skills/**` is
already inside `doc.*`'s write path, so the editor needs no new one; the tree extraction is
motivated by two genuinely subtle behaviours rather than by line count; the separate
`workspace:skilltree` channel is required by a global file cap rather than chosen for tidiness; and
the prose-only gate is enforced at the one place — `.strict()` on the args, before `run()` — where
a model cannot route around it.

The findings above are, with one exception, omissions rather than wrong turns: things the plan does
not say, in a plan whose distinguishing quality is how much it does say. The exception is finding 1,
which is a real bypass on the two filesystems this app actually runs on, and which the plan's own
test list would not catch.
