/**
 * Cloning a skill between tiers: a user or builtin skill into this project, or a project or
 * builtin one into the user's own folder. A clone is a copy, never a link — once made it is an
 * ordinary skill of its new tier, editable there and no longer tracked as coming from anywhere.
 *
 * Two commands rather than one with a target argument, because the framework declares `affects`
 * and `undoable` per command and the two targets differ: `.aiagent/skills` is in the tree an undo
 * snapshot covers, and the user's folder is in no workspace at all, so a write there can only be
 * `undoable: false`, the way `models.refresh` and `project.setKey`'s user scope already are.
 *
 * Neither is exposed to the agent. It can write a project skill through `create_skill`; cloning a
 * specific builtin into the project, or anything into the author's own machine-wide folder, is
 * the author's decision about their own files.
 */
import { defineFor, prop, type CheckResult } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** Turns a session preview into a check result, keeping its message in both cases. */
function verdict(result: { ok: true; note: string } | { ok: false; reason: string }): CheckResult {
  return result.ok ? { ok: true, note: result.note } : { ok: false, reason: result.reason };
}

export const skillCloneToProject = define({
  id         : 'skill.cloneToProject',
  title      : 'Clone a skill into this project',
  description:
    'Copy a user or builtin skill into this project’s `.aiagent/skills/<id>/`, as a fresh ' +
    'skill you can edit: the same `SKILL.md` the agent’s `create_skill` would write, front-matter ' +
    'it does not model carried over, and the script beside it when there is one. The original ' +
    'is untouched, and the copy shadows it from then on. A script that came along runs only ' +
    'after you confirm it, the same as any script a person just added. Refuses an id the ' +
    'project already holds rather than overwriting it.',
  notes:
    'Copy a user or builtin skill into `.aiagent/skills/` as an editable skill of the same id, which shadows the original. A script it carries is not pre-vetted: `run_skill` asks before its first run. Refuses over an existing id.',
  mutating   : true,
  affects    : ['.aiagent/skills'],
  undoable   : true,
  props: {
    id: prop.string('the skill’s id, as discover_skills or the Skills pane lists it'),
  },
  async check({ id }, ctx) {
    return verdict(await ctx.host.session.previewCloneSkill(id, 'project'));
  },
  async run({ id }, ctx) {
    const made = await ctx.host.session.cloneSkill(id, 'project');
    if (!made.ok) throw new Error(made.reason);
    // Shows the copy where the author will edit it, by the same route a click in the tree takes.
    ctx.host.ui(
      { type: 'view', action: 'open', editor: 'skills', where: 'elsewhere', subject: made.path },
      ctx.origin,
    );
    return { message: `Cloned ${id} into the project.`, data: made, written: made.written };
  },
});

export const skillCloneToUser = define({
  id         : 'skill.cloneToUser',
  title      : 'Clone a skill into your user folder',
  description:
    'Copy a project or builtin skill into your own skills folder, outside every project, so ' +
    'every project on this machine can read it: the same `SKILL.md` `create_skill` would write, ' +
    'front-matter it does not model carried over, and the script beside it when there is one. ' +
    'The original is untouched. A project skill of the same id still wins in that project. ' +
    'Refuses an id the folder already holds rather than overwriting it. Not undoable: the folder ' +
    'is in no repository, so no snapshot covers it.',
  notes:
    'Copy a project or builtin skill into the user-level `skills/` folder, beside `keys/`, for every project on this machine. **Not undoable**: the folder is outside every workspace, so no snapshot covers it. Refuses over an existing id.',
  mutating   : true,
  affects    : ['<user>/skills'],
  // The user folder is in no repository, and `snapshotted()` reports every `<user>` prefix as
  // uncovered, so an undo could not put the file back.
  undoable   : false,
  props: {
    id: prop.string('the skill’s id, as discover_skills or the Skills pane lists it'),
  },
  async check({ id }, ctx) {
    return verdict(await ctx.host.session.previewCloneSkill(id, 'user'));
  },
  async run({ id }, ctx) {
    const made = await ctx.host.session.cloneSkill(id, 'user');
    if (!made.ok) throw new Error(made.reason);
    ctx.host.ui(
      { type: 'view', action: 'open', editor: 'skills', where: 'elsewhere', subject: made.path },
      ctx.origin,
    );
    return { message: `Cloned ${id} into your user folder.`, data: made, written: made.written };
  },
});
