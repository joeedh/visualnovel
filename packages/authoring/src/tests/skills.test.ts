import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkills,
  isSkillId,
  newSkillTemplate,
  runSkill,
  skillId,
  skillRoots,
  skillWriteRefusal,
  writeSkill,
  PROJECT_SKILLS_DIR,
} from '../skills.js';

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
        'run.mjs' : 'console.log("hi from", process.argv[2]);',
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
        confirm      : () => Promise.resolve(false),
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
        'run.mjs' : 'console.log("root:" + process.argv[2]);',
      },
    });
    try {
      const skill = (await discoverSkills(skillRoots(root)))[0]!;
      const result = await runSkill(skill, {
        workspaceRoot: root,
        confirm      : () => Promise.resolve(true),
      });
      expect(result.ok).toBe(true);
      expect(result.ranScript).toBe(true);
      expect(result.output).toContain(`root:${root}`);
    } finally {
      await cleanup();
    }
  });
});

describe('skillId', () => {
  it('hyphenates, lowercases and stays ASCII', () => {
    expect(skillId('Name a Character')).toBe('name-a-character');
    expect(skillId('  Outfit — rules!  ')).toBe('outfit-rules');
    expect(skillId('Café Résumé')).toBe('cafe-resume');
    expect(skillId('Draft_v2')).toBe('draft-v2');
  });

  it('is empty when nothing survives, rather than inventing an id', () => {
    expect(skillId('!!!')).toBe('');
    expect(skillId('   ')).toBe('');
    // A wholly non-Latin name slugs to nothing on purpose: the id becomes a directory a script
    // is resolved against and handed to `execFile`, so it stays in the portable set.
    expect(skillId('日本語')).toBe('');
  });

  it('caps at 64 characters without leaving a trailing hyphen', () => {
    const id = skillId('a '.repeat(60));
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.endsWith('-')).toBe(false);
    expect(isSkillId(id)).toBe(true);
  });
});

describe('isSkillId', () => {
  it('accepts hyphenated lowercase and refuses everything else', () => {
    expect(isSkillId('name-a-character')).toBe(true);
    expect(isSkillId('a1')).toBe(true);
    expect(isSkillId('')).toBe(false);
    expect(isSkillId('Name')).toBe(false);
    expect(isSkillId('name_a')).toBe(false);
    expect(isSkillId('-name')).toBe(false);
    expect(isSkillId('name-')).toBe(false);
    expect(isSkillId('a--b')).toBe(false);
  });
});

describe('writeSkill', () => {
  const INPUT = {
    id         : 'pace-a-scene',
    name       : 'Pace a Scene',
    description: 'How long a beat should run.',
    whenToUse  : 'When a scene reads flat.',
    body       : 'Count the beats, then cut one.',
  };

  it('round-trips through discoverSkills', async () => {
    const { root, cleanup } = await tempWorkspace({});
    try {
      const res = await writeSkill(root, INPUT);
      expect(res.ok).toBe(true);

      const [skill] = await discoverSkills(skillRoots(root));
      expect(skill!.id).toBe('pace-a-scene');
      expect(skill!.name).toBe('Pace a Scene');
      expect(skill!.description).toBe('How long a beat should run.');
      expect(skill!.whenToUse).toBe('When a scene reads flat.');
      expect(skill!.body).toBe('Count the beats, then cut one.');
      expect(skill!.issues).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('writes the same bytes for the same input', async () => {
    const a = await tempWorkspace({});
    const b = await tempWorkspace({});
    try {
      const first = await writeSkill(a.root, INPUT);
      const second = await writeSkill(b.root, INPUT);
      expect(first.ok && second.ok).toBe(true);
      expect(await fs.readFile((first as { file: string }).file, 'utf8')).toBe(
        await fs.readFile((second as { file: string }).file, 'utf8'),
      );
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('refuses an id that is not one', async () => {
    const { root, cleanup } = await tempWorkspace({});
    try {
      // An id names one directory and never a path, so this refusal holds even for `overwrite`
      for (const id of ['', '.', '..', 'a/b']) {
        const res = await writeSkill(root, { ...INPUT, id }, { overwrite: true });
        expect(res.ok).toBe(false);
        expect((res as { reason: string }).reason).toContain('not a skill id');
      }
      const unconventional = await writeSkill(root, { ...INPUT, id: 'Pace_A_Scene' });
      expect(unconventional.ok).toBe(false);
      expect((unconventional as { reason: string }).reason).toContain('Latin');
    } finally {
      await cleanup();
    }
  });

  it('lets an unconventional id that already exists be rewritten', async () => {
    // `isSkillId` gates creation only: `edit_skill` resolves through `discoverSkills`, which
    // reads whatever the directory is called, so a hand-made id stays editable.
    const { root, cleanup } = await tempWorkspace({
      Pace_A_Scene: { 'SKILL.md': '---\nname: Old\ndescription: Old.\n---\n\nOld.\n' },
    });
    try {
      const res = await writeSkill(root, { ...INPUT, id: 'Pace_A_Scene' }, { overwrite: true });
      expect(res.ok).toBe(true);
      expect((await discoverSkills(skillRoots(root)))[0]!.name).toBe('Pace a Scene');
    } finally {
      await cleanup();
    }
  });

  it('refuses an existing directory, and overwrite preserves what it does not model', async () => {
    const { root, cleanup } = await tempWorkspace({
      'pace-a-scene': {
        'SKILL.md':
          '---\nname: Old\ndescription: Old.\nscript: run.mjs\nauthor: Joe\n---\n\nOld.\n',
        'run.mjs' : 'console.log("vetted");',
      },
    });
    try {
      expect((await writeSkill(root, INPUT)).ok).toBe(false);

      const before = (await discoverSkills(skillRoots(root)))[0]!;
      const res = await writeSkill(root, INPUT, { overwrite: true, preserve: before.raw });
      expect(res.ok).toBe(true);

      const after = (await discoverSkills(skillRoots(root)))[0]!;
      expect(after.name).toBe('Pace a Scene');
      expect(after.raw['script']).toBe('run.mjs');
      expect(after.raw['author']).toBe('Joe');
      // The vetted script is still the one that runs — a re-serialization moves no bytes.
      expect(after.script).toBe(join(root, PROJECT_SKILLS_DIR, 'pace-a-scene', 'run.mjs'));
    } finally {
      await cleanup();
    }
  });

  it('omits when-to-use rather than writing an empty key', async () => {
    const { root, cleanup } = await tempWorkspace({});
    try {
      await writeSkill(root, { ...INPUT, whenToUse: '   ' });
      const [skill] = await discoverSkills(skillRoots(root));
      expect(skill!.whenToUse).toBeUndefined();
      expect('when-to-use' in skill!.raw).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('newSkillTemplate', () => {
  it('is read back by discoverSkills, with all three keys intact', async () => {
    const { root, cleanup } = await tempWorkspace({
      'pace-a-scene': { 'SKILL.md': newSkillTemplate('Pace a Scene') },
    });
    try {
      const [skill] = await discoverSkills(skillRoots(root));
      expect(skill!.name).toBe('Pace a Scene');
      expect(skill!.description).toBeTruthy();
      expect(skill!.whenToUse).toBeTruthy();
      expect(skill!.body).toContain('Pace a Scene');
      expect(skill!.issues).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('skillIssues', () => {
  it('names what readSkill degraded over', async () => {
    const { root, cleanup } = await tempWorkspace({
      nameless: { 'SKILL.md': '---\ndescription: Something.\n---\n\nDo the thing.\n' },
      mute    : { 'SKILL.md': '---\nname: Mute\n---\n\nDo the thing.\n' },
      empty   : { 'SKILL.md': '---\nname: Empty\ndescription: Nothing.\n---\n' },
      stale: {
        'SKILL.md': '---\nname: Stale\ndescription: Stale.\nscript: build.mjs\n---\n\nRun it.\n',
        'run.mjs' : 'console.log("surprise");',
      },
    });
    try {
      const skills = await discoverSkills(skillRoots(root));
      const by = (id: string) => skills.find((s) => s.id === id)!;

      expect(by('nameless').issues.join(' ')).toContain('no name');
      expect(by('nameless').name).toBe('nameless');
      expect(by('mute').issues.join(' ')).toContain('no description');
      expect(by('empty').issues.join(' ')).toContain('no instructions');

      // `script:` names a file that is not there, so the scan finds a different script and runs
      // it under the confirm card's name.
      const stale = by('stale').issues.join(' ');
      expect(stale).toContain('build.mjs');
      expect(stale).toContain('run.mjs');
    } finally {
      await cleanup();
    }
  });

  it('is empty for a well-formed skill', async () => {
    const { root, cleanup } = await tempWorkspace({
      'name-character': { 'SKILL.md': PROSE_SKILL },
    });
    try {
      expect((await discoverSkills(skillRoots(root)))[0]!.issues).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('skillWriteRefusal', () => {
  it('refuses every path under the skills directory', () => {
    expect(skillWriteRefusal('.aiagent/skills/x/run.mjs')).toContain('create_skill');
    expect(skillWriteRefusal('.aiagent/skills/x/SKILL.md')).toBeTruthy();
    expect(skillWriteRefusal('.aiagent/skills/x/lib/y.js')).toBeTruthy();
    expect(skillWriteRefusal('.aiagent/skills')).toBeTruthy();
  });

  it('refuses the two bypasses `rel` leaves open', () => {
    // `rel` forward-slashes but does not case-fold, and `.AIAGENT` is the same directory on
    // Windows and on default macOS.
    expect(skillWriteRefusal('.AIAGENT/Skills/x/run.mjs')).toBeTruthy();
    expect(skillWriteRefusal('characters/../.aiagent/skills/x/run.mjs')).toBeTruthy();
  });

  it('allows everything else, including near misses', () => {
    expect(skillWriteRefusal('characters/aiko/character.md')).toBeNull();
    expect(skillWriteRefusal('.aiagent/config.json')).toBeNull();
    expect(skillWriteRefusal('characters/skills-notes.md')).toBeNull();
    expect(skillWriteRefusal('.aiagent/skillsets/x.md')).toBeNull();
  });
});
