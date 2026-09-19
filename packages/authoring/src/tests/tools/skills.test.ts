import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { userSkillsDir } from '@vn/config';
import { exists } from '@vn/util';
import { BUILTIN_SKILLS_PATH } from '../../skills.js';
import { run, tempProject, tool } from './testkit.js';

/** The catalog that ships with the app, reached from this test file's place in the checkout. */
const BUILTIN_DIR = join(__dirname, '..', '..', '..', '..', '..', ...BUILTIN_SKILLS_PATH);

describe('skills', () => {
  const NEW_SKILL = {
    name       : 'Pace a Scene',
    description: 'How long a beat should run before it is cut.',
    whenToUse  : 'When a scene reads flat.',
    body       : 'Count the beats, then cut one.',
  };

  it('create_skill writes a skill discover_skills then lists', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const res = await run('create_skill', NEW_SKILL, ctx);
      expect(res.ok).toBe(true);
      // Forward-slashed, like every workspace-relative path on the wire.
      expect(res.written).toEqual(['.aiagent/skills/pace-a-scene/SKILL.md']);

      const listed = await run('discover_skills', {}, ctx);
      expect(listed.output).toContain('pace-a-scene "Pace a Scene"');
      expect(listed.output).toContain('when: When a scene reads flat.');
      expect(listed.output).not.toContain('(!)');
    } finally {
      await cleanup();
    }
  });

  it('create_skill refuses a collision rather than overwriting', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      await run('create_skill', NEW_SKILL, ctx);
      const again = await run('create_skill', NEW_SKILL, ctx);
      expect(again.ok).toBe(false);
      expect(again.output).toBe('skill pace-a-scene already exists');
    } finally {
      await cleanup();
    }
  });

  it('create_skill refuses a name that slugs to nothing', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const res = await run('create_skill', { ...NEW_SKILL, name: '!!!' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('does not name a skill');
    } finally {
      await cleanup();
    }
  });

  it('has no script argument to pass — the schema refuses one before run() is entered', () => {
    expect(tool('create_skill').args.safeParse({ ...NEW_SKILL, script: 'run.mjs' }).success).toBe(
      false,
    );
    expect(tool('edit_skill').args.safeParse({ id: 'x', script: 'run.mjs' }).success).toBe(false);
  });

  it('edit_skill changes one field, reports it in written, and keeps a human script:', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('create_skill', NEW_SKILL, ctx);
      // A person adds a script by hand, the way the prose-only rule intends.
      const skillDir = join(dir, '.aiagent', 'skills', 'pace-a-scene');
      const md = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8');
      await fs.writeFile(
        join(skillDir, 'SKILL.md'),
        md.replace('---\n\n', 'script: run.mjs\n---\n\n'),
      );
      await fs.writeFile(join(skillDir, 'run.mjs'), 'console.log("vetted");');

      const res = await run('edit_skill', { id: 'pace-a-scene', description: 'Tighter.' }, ctx);
      expect(res.ok).toBe(true);
      expect(res.written).toEqual(['.aiagent/skills/pace-a-scene/SKILL.md']);

      const listed = await run('discover_skills', {}, ctx);
      expect(listed.output).toContain('Tighter.');
      // The name it was not asked to change survived, and so did the script.
      expect(listed.output).toContain('"Pace a Scene"');
      expect(listed.output).toContain('[project; script;');
    } finally {
      await cleanup();
    }
  });

  it('edit_skill refuses an unknown id', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const res = await run('edit_skill', { id: 'nope', body: 'x' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toBe('no such skill: nope');
    } finally {
      await cleanup();
    }
  });

  it('edit_skill refuses a user skill, and copies nothing into the project', async () => {
    const { ctx, cleanup } = await tempProject();
    // `$VNAUTHOR_HOME` is per jest worker, so this is a directory no other test reads.
    const shared = join(userSkillsDir(), 'shared');
    try {
      await fs.mkdir(shared, { recursive: true });
      await fs.writeFile(
        join(shared, 'SKILL.md'),
        '---\nname: Shared\ndescription: Not this project.\n---\n\nDo it.\n',
      );
      const listed = await run('discover_skills', {}, ctx);
      expect(listed.output).toContain('- shared "Shared" [user; guide]');

      const res = await run('edit_skill', { id: 'shared', description: 'Mine now.' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.output).toContain('shared is a user skill');
      expect(res.output).toContain('Clone it into the project');
      expect(await exists(join(ctx.workspace.root, '.aiagent', 'skills', 'shared'))).toBe(false);
    } finally {
      await fs.rm(shared, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('lists the builtin catalog when the host names it, tagged builtin', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const listed = await run('discover_skills', {}, { ...ctx, builtinSkillsDir: BUILTIN_DIR });
      expect(listed.output).toContain('- branching "Branch the Story" [builtin; guide;');
      expect(listed.output).toContain('- full-production ');
      expect(listed.output).toContain('- new-character ');
      // And nothing without the host's say-so: a bare context has no catalog to read.
      expect(await run('discover_skills', {}, ctx)).toMatchObject({ data: [] });
    } finally {
      await cleanup();
    }
  });

  it('edit_skill and create_skill refuse a builtin id; a project skill of that id is still editable', async () => {
    const { ctx, cleanup } = await tempProject();
    const hosted = { ...ctx, builtinSkillsDir: BUILTIN_DIR };
    try {
      const edit = await run('edit_skill', { id: 'branching', body: 'Mine.' }, hosted);
      expect(edit.ok).toBe(false);
      expect(edit.output).toContain('branching is a builtin skill');
      expect(edit.output).toContain('clone it into the project first');

      const create = await run('create_skill', { ...NEW_SKILL, name: 'Branching' }, hosted);
      expect(create.ok).toBe(false);
      expect(create.output).toContain('branching is already a builtin skill');
      expect(await exists(join(ctx.workspace.root, '.aiagent', 'skills', 'branching'))).toBe(false);

      // A project skill written under that id — by a person, or by cloning — shadows the
      // builtin one and is the project's to edit.
      await fs.mkdir(join(ctx.workspace.root, '.aiagent', 'skills', 'branching'), {
        recursive: true,
      });
      await fs.writeFile(
        join(ctx.workspace.root, '.aiagent', 'skills', 'branching', 'SKILL.md'),
        '---\nname: My Branching\ndescription: Mine.\n---\n\nFork it my way.\n',
      );
      const listed = await run('discover_skills', {}, hosted);
      expect(listed.output).toContain('- branching "My Branching" [project; guide]');
      expect(listed.output).not.toContain('Branch the Story');
      const again = await run('edit_skill', { id: 'branching', body: 'Still mine.' }, hosted);
      expect(again.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('a builtin skill project.yaml leaves out of builtin_skills is absent', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    const hosted = { ...ctx, builtinSkillsDir: BUILTIN_DIR };
    try {
      await fs.writeFile(
        join(dir, 'project.yaml'),
        'title: Test Project\nstart: arrival\nbuiltin_skills:\n  - new-character\n  - retired\n',
      );
      const listed = await run('discover_skills', {}, hosted);
      expect(listed.data).toMatchObject([{ id: 'new-character', tier: 'builtin' }]);
      // Off is off for creation too: enabling it later must not reveal a different skill.
      const create = await run('create_skill', { ...NEW_SKILL, name: 'Branching' }, hosted);
      expect(create.ok).toBe(false);
      expect(create.output).toContain('already a builtin skill');
    } finally {
      await cleanup();
    }
  });

  it('write_file cannot author anything under .aiagent/skills', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      for (const path of ['.aiagent/skills/x/run.mjs', '.aiagent/skills/x/SKILL.md']) {
        const res = await run('write_file', { path, content: 'whatever' }, ctx);
        expect(res.ok).toBe(false);
        expect(res.output).toContain('create_skill');
        expect(await exists(join(dir, path))).toBe(false);
      }
      // Everything else under .aiagent is still ordinary.
      expect((await run('write_file', { path: '.aiagent/notes.md', content: 'ok' }, ctx)).ok).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });

  it('edit_file cannot rewrite a script a person put beside a skill', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      // The gate exists for this case: the script is already there, vetted, and `run_skill` offers
      // to execute it. An edit is the other way to author one.
      const skillDir = join(dir, '.aiagent', 'skills', 'x');
      await fs.mkdir(skillDir, { recursive: true });
      const script = join(skillDir, 'run.mjs');
      const before = 'process.stdout.write(1);';
      await fs.writeFile(script, before);

      const res = await run(
        'edit_file',
        { path: '.aiagent/skills/x/run.mjs', edits: [{ old: 'write(1)', new: 'write(2)' }] },
        ctx,
      );
      expect(res.ok).toBe(false);
      expect(res.output).toContain('create_skill');
      expect(await fs.readFile(script, 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('discover_skills flags what a skill degraded over instead of printing it as fine', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const skillDir = join(dir, '.aiagent', 'skills', 'mute');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(join(skillDir, 'SKILL.md'), '---\nname: Mute\n---\n\nDo the thing.\n');

      const listed = await run('discover_skills', {}, ctx);
      expect(listed.output).toContain('(!)');
      expect(listed.output).toContain('no description');
      expect(listed.data).toMatchObject([{ id: 'mute', issues: [expect.any(String)] }]);
    } finally {
      await cleanup();
    }
  });

  it('both writers are mutating, and neither borrows run_skill confirm card', () => {
    for (const name of ['create_skill', 'edit_skill']) {
      expect(tool(name).mutating).toBe(true);
      expect(tool(name).confirm).toBeUndefined();
    }
  });
});
