// ── Skills ────────────────────────────────────────────────────────────────────
import { join, relative } from 'node:path';
import { z } from 'zod';
import {
  discoverSkills,
  runSkill,
  skillId,
  skillRoots,
  writeSkill,
  PROJECT_SKILLS_DIR,
} from '../skills.js';
import { ok, fail, rel, type Tool } from './core.js';

const discoverSkillsTool: Tool<Record<string, never>> = {
  name       : 'discover_skills',
  description: 'List available authoring skills (reusable playbooks) and when to use them.',
  mutating   : false,
  args       : z.object({}).strict(),
  async run(_a, ctx) {
    const skills = await discoverSkills(skillRoots(ctx.workspace.root, ctx.skillDirs));
    if (skills.length === 0) return ok('No skills found under .aiagent/skills.', { data: [] });
    const body = skills
      .map((s) => {
        const tags = [s.script ? 'script' : 'guide', s.whenToUse ? `when: ${s.whenToUse}` : '']
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
    const skills = await discoverSkills(skillRoots(ctx.workspace.root, ctx.skillDirs));
    const skill = skills.find((s) => s.id === a.id || s.name === a.id);
    if (!skill) return fail(`no such skill: ${a.id}`);
    // `ctx.skillDirs` roots can point outside the workspace, and `writeSkill` resolves an id
    // against this project, so editing one of those would silently fork it into the project.
    const inProject = relative(join(ctx.workspace.root, PROJECT_SKILLS_DIR), skill.dir);
    if (inProject !== skill.id) {
      return fail(
        `skill ${skill.id} lives outside this project (${skill.dir}); edit_skill only writes .aiagent/skills/.`,
      );
    }
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
    const skills = await discoverSkills(skillRoots(ctx.workspace.root, ctx.skillDirs));
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
