# Builtin skills

## Problem

Skills (`docs/reference/vnauthor.md#skills`) only exist per project, at
`.aiagent/skills/<id>/`. The three that exist today ship as a side effect of copying
`templates/basic` — there is no way to get them into an existing project, no way to update
them without hand-editing, and no way to see them without opening the file tree.

Decided in conversation: promote all three (`new-character`, `branching`,
`full-production`) to a fixed builtin catalog, enabled by default in every project. Users
can disable individual builtin skills per project, and can clone a builtin skill into
their project or into their user folder to get an editable copy — cloning does not happen
automatically just because a skill is enabled.

## Three tiers

```
builtin   (packages/authoring/builtin-skills/*)   read-only, ships with the app
  ↓ clone
user      (<userConfigDir>/skills/*)              editable, shared across projects
  ↓ clone
project   (.aiagent/skills/*)                     editable, committed with the project
```

- **Builtin** — a fixed catalog inside `@vn/authoring`, one directory per skill, same
  shape as today's (`SKILL.md` + optional script). Ships with the app and updates when the
  app updates. Not stored under any project's `.aiagent/`.
- **User** — `<userConfigDir>/skills/<id>/`, new sibling of the existing `keys/` directory
  (`packages/config/src/keys.ts`). Same Local-not-Roaming reasoning as keys: a skill a
  person wrote for themselves should not silently follow them to another machine's
  project, only be there because they cloned it there.
- **Project** — unchanged, `.aiagent/skills/<id>/`.

### Discovery order and id collisions

`discoverSkills(roots)` takes a flat `roots: string[]` and a `seen` set — first root to
produce an id wins, later roots' matching ids are skipped, not merged or marked
(`packages/authoring/src/skills.ts:137-159`). That much is reusable as-is for
"project-first" ordering:

```
skillRoots = [ project .aiagent/skills, ...userConfigDirs skills, builtinSkillsDir ]
```

This mirrors the existing key-resolution precedence in CLAUDE.md (env var → project's own
`keys/` → repo root `keys/` → user-level) — the closest, most-recently-edited copy always
wins. A project skill named `branching` shadows the builtin one of the same id; nothing
merges.

Builtin roots contribute only ids the project has enabled (filtered against the real
catalog, ignoring stale/unknown ids — see the schema note above); a disabled builtin skill
is simply absent from discovery for that project, same as a project skill directory that
was deleted. Disabling touches no files, because builtin skills have no per-project files
to touch.

**This is more than a root-list change.** `Skill` has no tier/root-origin field today
(`skills.ts:36-58`), and the flat `extraDirs` list already threaded through
`skillRoots`/`ctx.skillDirs` (`packages/authoring/src/tools/core.ts:78`, used by all four
skill tools and the REPL) doesn't distinguish "user" from "builtin" either. Landing this
needs three separate, sequenced changes: (1) add the two new roots, (2) tag each `Skill`
with which tier/root it resolved from, (3) filter the builtin root's contents by the
project's `builtin_skills` list before or during discovery. Rollout item 2 lists these as
separate work; call that out up front too so it isn't read as a one-line change.

## Enablement: `project.yaml`

New key, a list of builtin skill ids:

```yaml
builtin_skills:
    - new-character
    - branching
    - full-production
```

- Schema: extend `projectConfig` (`@vn/types`, `packages/types/src/schemas.ts:314-374`)
  with `builtin_skills: z.array(z.string()).default([...every builtin id...])`, so a
  `project.yaml` written before this key existed (or one that never mentions it) behaves
  as "all enabled" rather than "none enabled." A plain `z.array(z.string())` validates
  only that each entry is a string — it has no notion of "known builtin id" and cannot
  drop an unknown one itself. Filtering the list against the real catalog (so a
  `project.yaml` surviving a builtin skill's removal from the app doesn't start failing to
  parse) has to happen where the list is _consumed_ — in `skillRoots`/`discoverSkills` —
  not in the schema. Silently ignore an id the catalog doesn't have; don't refuse.
- Splice helper: needs its own function, `withBuiltinSkills`, modeled on
  `withImageModel`'s header-plus-block handling (`packages/config/src/config.ts:130-171`),
  not on reusing `withConfigKey` as-is. `withConfigKey` is typed for a single scalar value
  (`ConfigTextKey = 'art_style' | 'storyboard_notes' | 'lettering'`,
  `packages/config/src/config.ts:62,77-108`) and calls `stringifyYaml({ [key]: value })`
  with `value: string`; it has never taken an array, and `withImageModel` already had to
  write its own header/block logic rather than reuse it for exactly this reason. Treat
  `withBuiltinSkills` as new code with the same shape as `withImageModel`, not as a small
  extension of `withConfigKey`.
- Command: `project.setBuiltinSkills(ids: string[])`, `affects: ['project.yaml']`,
  undoable. Surfaced as a set of checkboxes, one per builtin skill, wherever the Project
  editor already lists project-level toggles (`docs/reference/desktop-app-editors-misc.md`
  — the same editor that owns `art_style`/`models.image`/`lettering`).

## Cloning

Copy, not link or sync — same relationship a project macro would have to a user macro
(`docs/research/user-authored-macros-and-custom-actions.md:258-260`). A clone is a fresh,
independent `SKILL.md` (+ script, if any) at the target root, written through the same
`writeSkill` used by `create_skill`/`doc.create kind='skill'`, so a cloned skill and a
hand-created one are byte-identical in shape. After cloning, the copy is an ordinary
project or user skill: editable, and no longer tracked as "from" the builtin.

- **Two commands, not one with a `target` argument: `skill.cloneToProject(id)` and
  `skill.cloneToUser(id)`.** The command framework declares `affects`/`undoable`
  statically per command (`docs/reference/command-system.md`), and the two targets need
  different values: cloning into `.aiagent/skills` is undoable like any other project
  write (`doc.ts:119`), but cloning into `<userConfigDir>/skills` is not — every command
  that writes under the `<user>` affects root is `undoable: false`, because
  `snapshotted()` always reports the user root as unsnapshotted
  (`apps/desktop/src/shared/affects.ts:116-119`; see `models.ts:4,21` for the existing
  precedent of a command declaring `undoable: false` for exactly this reason). One command
  whose `undoable` value depends on a runtime argument isn't expressible in this
  framework, so split it. `<user>/skills` as an affects-root path is otherwise sound —
  `<user>/plugins` and `<user>/models.json` are already precedented siblings under
  `USER_ROOT` (`affects.ts:39`).
    - Both refuse if the target already has a skill at that id (same "won't overwrite
      silently" rule `writeSkill` already enforces) — surface it as a rename prompt, not a
      silent skip.
    - A script-bearing builtin skill clones its script too. The clone is **not**
      pre-vetted: `run_skill`'s confirm-before-first-script-run gate applies to the clone
      the same as any script a person just added, per the existing rule that a script must
      arrive by a person's own act (`docs/reference/vnauthor.md:534-536`). Cloning is that
      act for the copy, same as it would be for a hand-authored one — the builtin original
      having already been vetted once does not carry over.
    - Not exposed as an agent tool. The agent can already write project skills via
      `create_skill`; cloning a specific builtin into the project or into the _user's own_
      folder is an author decision about their own machine, not something `vnauthor`
      should initiate. (Open question below.)

## `discover_skills`, `create_skill`, `edit_skill`, `run_skill`

- `discover_skills` reports a skill's tier (`project` / `user` / `builtin`) alongside its
  existing `(!)` issue-flagging, so the agent (and the Skills pane) can say why a skill
  can't be edited.
- `create_skill` / `edit_skill` refuse a builtin id outright — "`<id>` is a builtin skill
  and can't be edited here; clone it into the project first" — the same shape as the
  existing `write_file` → `.aiagent/skills/` refusal that names
  `create_skill`/`edit_skill` instead. A project skill that happens to share an id with a
  builtin (shadowing it, per discovery order above) is still editable — the refusal is
  keyed to _which root_ the resolved skill actually came from, not the id string. This is
  precedented, not new invention: `edit_skill` already refuses this way for the
  project-vs-outside case, by comparing `skill.dir` against the project skills root
  (`packages/authoring/src/tools/skills.ts:133-140`) rather than a stored tier field.
  Extending it to the builtin/user case is straightforward, but only once the tier tagging
  above exists — today's mechanism works by path comparison, not by an already-tracked
  tier, so it isn't "already implementable" on its own.
- `run_skill` is unaffected: a builtin skill runs exactly like a project one once
  discovered, prose-only or script-with-confirm.

## Skills editor

(`apps/desktop/renderer/pathux/editors/skills.ts`,
`docs/reference/desktop-app-editors-misc.md#skills`)

- The skill tree groups by tier, or at minimum marks each row's tier (a lock glyph on
  builtin rows, per the existing tooltip convention — the row says _why_ it's locked, not
  just that it is).
- Opening a builtin skill shows its body read-only (no field edits, no rename, no delete)
  and two actions in place of the edit controls: **Clone into project** / **Clone into
  user folder**, wired to `skill.cloneToProject` / `skill.cloneToUser`. Tooltip: "Copies
  this skill so you can edit it — the builtin one is unaffected either way."
- A disabled builtin skill still needs to be visible and cloneable (so an author can grab
  a copy of something they've turned off project-wide), so "enabled" is a project.yaml
  flag surfaced in the Project editor, not a filter in the Skills pane itself. The pane
  shows every builtin regardless of enablement; a small badge says whether it is currently
  enabled for this project.
- `workspace:skilltree`'s channel walks `.aiagent/skills` today
  (`docs/reference/desktop-app-editors-misc.md:89-93`); it needs to also walk the resolved
  user and builtin roots and tag each row with its tier, same data `discover_skills`
  reports for the agent.
- Use the frontend design skill to review/inform your changes to the skills editor.

## Migration

- Remove `templates/basic/.aiagent/skills/{new-character,branching,full-production}/`.
  Move their content to `packages/authoring/builtin-skills/<id>/` verbatim (same
  `SKILL.md` shape; no content changes as part of this plan).
- `templates/basic`'s own `project.yaml` needs no `builtin_skills:` key — the schema
  default is "all enabled," and this project should ship as the everything-on example.
- Existing projects that already have a `.aiagent/skills/new-character/` (etc.) of their
  own keep it: discovery order means their copy shadows the builtin one, so nothing
  changes for them silently. No back-fill, no forced rename.
- `docs/reference/vnauthor.md#skills` gets rewritten for three tiers instead of "three
  skills ship with the sample."
- Checked: no test pins the count or content of `templates/basic/.aiagent/skills/`, and
  the desktop project-scaffold copier (`apps/desktop/src/main/workspace/workspace.ts`) has
  no skills-specific logic — it copies the whole `templates/basic` tree generically, so
  removing the three directories needs no corresponding code change there. Migration risk
  is low.

## Open questions

- **Should the agent be able to clone, not just the desktop UI?** Leaning no (above). This
  one is genuinely fine to leave open: `discover_skills`/`create_skill`/`edit_skill`/
  `run_skill` are the only agent-facing skill tools today, all one shape in one file
  (`packages/authoring/src/tools/skills.ts`, `tools/core.ts`), so adding a `clone_skill`
  tool later, if wanted, is mechanically cheap and doesn't need deciding now.
- **Versioning a builtin skill across app updates.** If `full-production`'s body changes
  in a later app release, a project that already cloned it keeps the old copy (correct —
  it's an independent file now), but a project that only has it _enabled_ picks up the new
  wording automatically next run. Worth a line in the release notes template when a
  builtin skill's body changes, but no code is needed for it.
- **Script-bearing builtin skills.** None of the three today ship a script. If one ever
  does, its clone lands unvetted (per Cloning above) — flagged here so it isn't missed
  when the first script-bearing builtin is added.

## Rollout

1. `packages/config`: schema + `withBuiltinSkills` + `setBuiltinSkills` + tests.
2. `packages/authoring`: builtin catalog dir, `skillRoots` extended with user + builtin,
   tier tagging in `Skill`/`discoverSkills`, filtering the builtin root by
   `builtin_skills`, refusals in `create_skill`/`edit_skill`, `cloneSkill` (the underlying
   function both clone commands call).
3. `apps/desktop`: `project.setBuiltinSkills` + `skill.cloneToProject` +
   `skill.cloneToUser` commands, Project editor checkboxes, Skills pane tier badges +
   clone actions, `workspace:skilltree` tier data.
4. Move the three skill directories out of `templates/basic`, update
   `docs/reference/vnauthor.md`.
5. `pnpm gen:uxmodel` (new commands/situations) + anchor sweep re-run
   (`docs/reference/guided-tours.md`).

This plan should be pressure-tested by a fresh-context agent before any of the above
starts, per `CLAUDE.md`'s plan-review convention.

## As shipped

Three stages, one commit each, on the `builtin-skills` branch. `pnpm check`, `pnpm test`
and `pnpm lint` are green. The Skills pane, both clone commands (with undo of the project
clone) and `project.setBuiltinSkills` (with undo) were checked live over CDP against
`examples/mySampleRepo`, and the anchor sweep was re-run.

- Stage 1 (`packages/config`, `packages/types`): `builtin_skills` on the schema with
  `BUILTIN_SKILL_IDS` as its default, `withBuiltinSkills` / `setBuiltinSkills`,
  `userSkillsDir`.
- Stage 2 (`packages/authoring`, `apps/authoring`): the catalog moved to
  `packages/authoring/builtin-skills/`, `skillRoots` over three tiers with the builtin
  root's `enabled` set read from the config, `tier` and `enabled` on `Skill`,
  `discoverSkills({ keepDisabled })`, `cloneSkill`, the `create_skill` / `edit_skill`
  refusals, the tier in `discover_skills`'s listing, and `ToolContext.builtinSkillsDir`
  supplied by each host.
- Stage 3 (`apps/desktop`, docs): `project.setBuiltinSkills`, `skill.cloneToProject`,
  `skill.cloneToUser`; the Project pane's checkbox card; the Skills pane's tier headings,
  read-only view, clone buttons and tier badge; virtual `<user>/skills/…` and
  `<builtin>/…` doc paths; the catalog in `extraResources` with a `skills` smoke check;
  the docs named under Rollout plus `document-tree.md`, `desktopAppState.md` and
  `CLAUDE.md`.

### Deviations

- **The host supplies the builtin directory rather than `@vn/authoring` finding it.**
  `@vn/authoring` is source-only and bundled into two apps, so it has no reliable
  `import.meta.url` to walk from. `BUILTIN_SKILLS_PATH` is exported instead; `vnauthor`
  walks up from its bundle and the desktop app goes through `resourcePath()`, which is
  also how the packaged build finds it. Under jest neither resolves, so tests that need
  the catalog set `VN_RESOURCES` to the checkout.
- **A user skill is read-only in the Skills pane.** The plan made only builtin skills
  read-only. Writing a user skill from the pane would need a non-undoable write command
  (`doc.write` is undoable and covers only the workspace), so the pane shows a user skill
  the way it shows a builtin one and names its folder; "Clone into project" gives an
  editable copy. The agent's `edit_skill` refuses user skills for the same reason. Worth
  its own small change if editing in place turns out to matter.
- **The Skills pane badges the tier in its foot rather than beside each tree row.** The
  tree already groups by heading, so a per-row tier badge would repeat the heading; the
  row badge is kept for `script` and `off`.
- **`skill.cloneToUser` is not undoable**, as the affects rules require for a `<user>`
  write; the plan's "undo removes the copy" applies to the project clone only.
