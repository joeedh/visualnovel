import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, runSkill, skillRoots, PROJECT_SKILLS_DIR } from '../skills.js';

/** Create a workspace with the given skill directories laid out under `.aiagent/skills`. */
async function tempWorkspace(
  skills: Record<string, Record<string, string>>,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'vn-skills-'));
  for (const [id, files] of Object.entries(skills)) {
    const dir = join(root, PROJECT_SKILLS_DIR, id);
    await fs.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(join(dir, name), content);
    }
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

const PROSE_SKILL = `---
name: Name a Character
description: Conventions for naming a new character.
when-to-use: When the user adds a character without a name.
---

Pick a name that fits the setting and is easy to read aloud.
`;

const SCRIPT_SKILL = `---
name: Echo Root
description: Prints the workspace root it was handed.
---

Run the bundled script.
`;

describe('discoverSkills', () => {
  it('reads front-matter and classifies prose vs. script skills', async () => {
    const { root, cleanup } = await tempWorkspace({
      'name-character': { 'SKILL.md': PROSE_SKILL },
      'echo-root': {
        'SKILL.md': SCRIPT_SKILL,
        'run.mjs': 'console.log("hi from", process.argv[2]);',
      },
    });
    try {
      const skills = await discoverSkills(skillRoots(root));
      expect(skills.map((s) => s.id)).toEqual(['echo-root', 'name-character']);

      const prose = skills.find((s) => s.id === 'name-character')!;
      expect(prose.name).toBe('Name a Character');
      expect(prose.whenToUse).toContain('without a name');
      expect(prose.script).toBeUndefined();
      expect(prose.body).toContain('fits the setting');

      const scripted = skills.find((s) => s.id === 'echo-root')!;
      expect(scripted.script).toBe(join(root, PROJECT_SKILLS_DIR, 'echo-root', 'run.mjs'));
    } finally {
      await cleanup();
    }
  });

  it('returns nothing when there is no skills directory', async () => {
    const { root, cleanup } = await tempWorkspace({});
    try {
      expect(await discoverSkills(skillRoots(root))).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('runSkill', () => {
  it('returns the body as guidance for a prose skill (no confirm needed)', async () => {
    const { root, cleanup } = await tempWorkspace({
      'name-character': { 'SKILL.md': PROSE_SKILL },
    });
    try {
      const skill = (await discoverSkills(skillRoots(root)))[0]!;
      const result = await runSkill(skill, { workspaceRoot: root });
      expect(result.ok).toBe(true);
      expect(result.ranScript).toBe(false);
      expect(result.output).toContain('fits the setting');
    } finally {
      await cleanup();
    }
  });

  it('refuses a script skill when there is no confirmation channel', async () => {
    const { root, cleanup } = await tempWorkspace({
      'echo-root': { 'SKILL.md': SCRIPT_SKILL, 'run.mjs': 'console.log("ran");' },
    });
    try {
      const skill = (await discoverSkills(skillRoots(root)))[0]!;
      const result = await runSkill(skill, { workspaceRoot: root });
      expect(result.ok).toBe(false);
      expect(result.ranScript).toBe(false);
      expect(result.output).toContain('needs confirmation');
    } finally {
      await cleanup();
    }
  });

  it('does not run a script skill when confirmation is declined', async () => {
    const { root, cleanup } = await tempWorkspace({
      'echo-root': { 'SKILL.md': SCRIPT_SKILL, 'run.mjs': 'console.log("ran");' },
    });
    try {
      const skill = (await discoverSkills(skillRoots(root)))[0]!;
      const result = await runSkill(skill, {
        workspaceRoot: root,
        confirm: () => Promise.resolve(false),
      });
      expect(result.ok).toBe(false);
      expect(result.ranScript).toBe(false);
      expect(result.output).toContain('Declined');
    } finally {
      await cleanup();
    }
  });

  it('runs an approved script skill, passing the workspace root', async () => {
    const { root, cleanup } = await tempWorkspace({
      'echo-root': {
        'SKILL.md': SCRIPT_SKILL,
        'run.mjs': 'console.log("root:" + process.argv[2]);',
      },
    });
    try {
      const skill = (await discoverSkills(skillRoots(root)))[0]!;
      const result = await runSkill(skill, {
        workspaceRoot: root,
        confirm: () => Promise.resolve(true),
      });
      expect(result.ok).toBe(true);
      expect(result.ranScript).toBe(true);
      expect(result.output).toContain(`root:${root}`);
    } finally {
      await cleanup();
    }
  });
});
