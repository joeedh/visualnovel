// ── Skills ────────────────────────────────────────────────────────────────────
import { z } from 'zod';
import {
  discoverSkills,
  runSkill,
  skillId,
  skillRoots,
  writeSkill,
  type Skill,
} from '../skills.js';
import { ok, fail, rel, type Tool, type ToolContext } from './core.js';

/** Every skill the agent can see from this context, project first. */
function visibleSkills(ctx: ToolContext, opts: { keepDisabled?: boolean } = {}): Promise<Skill[]> {
  return skillRoots(ctx.workspace.root, { builtinDir: ctx.builtinSkillsDir }).then((roots) =>
    discoverSkills(roots, opts),
  );
}

/**
 * Why a skill outside the project cannot be written here. A builtin skill ships with the app and
 * a user skill is shared across projects; both are edited as a copy, which the desktop's Clone
 * actions make. Named by tier rather than by path, because a project skill that shadows a
 * builtin one is still the project's to edit.
 */
function notProject(skill: Skill, verb: string): string {
  return skill.tier === 'builtin'
    ? `${skill.id} is a builtin skill and can't be ${verb} here; clone it into the project first ` +
        '(Skills pane ▸ Clone into project), then edit the copy.'
    : `${skill.id} is a user skill (${skill.dir}), shared across projects; ${verb} only reaches ` +
        "this project's .aiagent/skills/. Clone it into the project first, then edit the copy.";
}

const discoverSkillsTool: Tool<Record<string, never>> = {
  name       : 'discover_skills',
  description:
    'List available authoring skills (reusable playbooks) and when to use them. Each is tagged ' +
    'with where it comes from: this project, your user folder, or the builtin catalog.',
  mutating   : false,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    const skills = await visibleSkills(ctx);
    if (skills.length === 0) return ok('No skills found.', { data: [] });
    const body = skills
      .map((s) => {
        const tags = [
          s.tier,
          s.script ? 'script' : 'guide',
          s.whenToUse ? `when: ${s.whenToUse}` : '',
        ]
          .filter(Boolean)
          .join('; ');
        // A degraded skill — no description, no body, a `script:` naming a missing file — would
        // read as fine in a catalogue that prints only what parsed, so its issues are appended.
        const issues = s.issues.length ? ` (!) ${s.issues.join('; ')}` : '';
        return `- ${s.id} "${s.name}" [${tags}]: ${s.description}${issues}`;
      })
      .join('\n');
    return ok(body, {
      data: skills.map((s) => ({
        id    : s.id,
        name  : s.name,
        tier  : s.tier,
        script: !!s.script,
        issues: s.issues,
      })),
    });
  },
};

/**
 * Writing a skill, in two tools that share one rule: prose only.
 *
 * Three independent facts make `run_skill`'s confirm card unspoofable through them:
 *
 * 1. The card is ``Skill "${skill.id}" wants to run a script: ${skill.script}`` — the directory
 *    name and the resolved absolute path, neither of which appears in an `edit_skill` patch.
 * 2. Both `args` schemas are `.strict()`, so a `script` argument is a parse error before `run()`
 *    is entered rather than a field to be filtered inside it.
 * 3. The desktop agent is built with no `registry` (`session.ts`), so `doc.write` — the one other
 *    path to a `run.mjs` — is not among its tools, and `write_file` is gated below.
 *
 * `git_restore` and `git_revert` still take an arbitrary path and could bring a deleted `run.mjs`
 * back. That is deliberate: both are `confirm: true` and, unlike `run_skill`'s card, theirs name
 * the file, so a person approves that specific restore. Prose only means the agent cannot author
 * a script, not that no tool can move bytes.
 */
const createSkillTool: Tool<{
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  id?: string;
}> = {
  name       : 'create_skill',
  description:
    'Write a new skill — a reusable playbook at .aiagent/skills/<id>/SKILL.md that ' +
    'discover_skills offers back later. Use it when the author asks for a repeatable procedure. ' +
    'Prose only: there is deliberately no script argument, because a skill that runs a script ' +
    'has to be added by a person.',
  mutating   : true,
  args: z
    .object({
      name: z.string().min(1).describe('what the skill is called; the id is derived from it'),
      description: z.string().min(1).describe('one sentence — this is what a later you decides by'),
      whenToUse  : z.string().optional().describe('the situation that should call for this skill'),
      body       : z.string().min(1).describe('the procedure, as steps to follow'),
      id: z.string().optional().describe('override the derived id (lowercase, hyphenated)'),
    })
    .strict(),
  async run(a, ctx) {
    const id = a.id?.trim() ? a.id.trim() : skillId(a.name);
    if (!id) {
      return fail(
        `"${a.name}" does not name a skill: a skill id is a directory name, so give it a ` +
          'name with Latin letters or digits in it.',
      );
    }
    // A project skill would shadow a user or builtin one of the same id, and the agent would
    // have written a new playbook where the author expected the old one. Disabled builtins count
    // too: turning a skill back on must not reveal a different one under its name.
    const taken = (await visibleSkills(ctx, { keepDisabled: true })).find((s) => s.id === id);
    if (taken && taken.tier !== 'project') {
      const where = taken.tier === 'user' ? ` (${taken.dir})` : '';
      return fail(
        `${id} is already a ${taken.tier} skill${where}, and a project skill of that id would ` +
          'shadow it. Clone it into the project to edit a copy, or give this one another name.',
      );
    }
    const res = await writeSkill(ctx.workspace.root, {
      id,
      name       : a.name,
      description: a.description,
      whenToUse  : a.whenToUse,
      body       : a.body,
    });
    if (!res.ok) return fail(res.reason);
    return ok(`Created skill ${res.id}.`, {
      written: [rel(ctx.workspace.root, res.file)],
      data   : { id: res.id },
    });
  },
};

const editSkillTool: Tool<{
  id: string;
  name?: string;
  description?: string;
  whenToUse?: string;
  body?: string;
}> = {
  name       : 'edit_skill',
  description:
    'Change one or more fields of an existing skill. Omitted fields are left alone, and ' +
    'front-matter this tool does not model — a `script:` a person added, say — is carried ' +
    'forward. YAML *comments* are not: the file is re-emitted in canonical key order.',
  mutating   : true,
  args: z
    .object({
      id         : z.string().min(1),
      name       : z.string().optional(),
      description: z.string().optional(),
      whenToUse  : z.string().optional(),
      body       : z.string().optional(),
    })
    .strict(),
  async run(a, ctx) {
    const skills = await visibleSkills(ctx);
    const skill = skills.find((s) => s.id === a.id || s.name === a.id);
    if (!skill) return fail(`no such skill: ${a.id}`);
    // `writeSkill` resolves an id against this project, so editing a user or builtin skill
    // would silently fork it into the project under the same name.
    if (skill.tier !== 'project') return fail(notProject(skill, 'edited'));
    const res = await writeSkill(
      ctx.workspace.root,
      {
        id         : skill.id,
        name       : a.name ?? skill.name,
        description: a.description ?? skill.description,
        whenToUse  : a.whenToUse ?? skill.whenToUse,
        body       : a.body ?? skill.body,
      },
      { overwrite: true, preserve: skill.raw },
    );
    if (!res.ok) return fail(res.reason);
    // `written` is load-bearing: the desktop invalidates its trees off `agent:event` only when
    // it is non-empty, so an edit that reported nothing would leave both panes showing the old
    // description until something else wrote.
    return ok(`Updated skill ${res.id}.`, {
      written: [rel(ctx.workspace.root, res.file)],
      data   : { id: res.id },
    });
  },
};

const runSkillTool: Tool<{ name: string }> = {
  name       : 'run_skill',
  description:
    'Run a skill by id/name. Prose skills return guidance; script-bearing skills run only ' +
    'after explicit confirmation.',
  mutating   : true,
  args       : z.object({ name: z.string().min(1) }),
  async run(a, ctx) {
    const skills = await visibleSkills(ctx);
    const skill = skills.find((s) => s.id === a.name || s.name === a.name);
    if (!skill) return fail(`no such skill: ${a.name}`);
    const result = await runSkill(skill, {
      workspaceRoot: ctx.workspace.root,
      confirm      : ctx.confirm,
    });
    return { ok: result.ok, output: result.output };
  },
};

export { discoverSkillsTool, createSkillTool, editSkillTool, runSkillTool };
