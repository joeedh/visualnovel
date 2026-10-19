import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { exists } from '@vn/util';
import { run, tempProject, tool } from './testkit.js';

/**
 * The agent's deletes refuse, by name, while a reference that needs a decision remains, and the
 * rewrites behind them are `@vn/scriptedit`'s, which has its own suites. These cases cover the
 * seam: the refusals, what goes, and that every removal asks first.
 */
describe('the delete tools', () => {
  it('are all mutating and always confirmed', () => {
    for (const name of ['delete_character', 'delete_location', 'delete_files']) {
      expect(tool(name)).toMatchObject({ mutating: true, confirm: true });
    }
  });
});

describe('delete_character', () => {
  it('refuses while the character speaks, naming each scene and its count', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const r = await run('delete_character', { character: 'aiko' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/^aiko still speaks 2 lines: arrival \(1\), ending \(1\)\./);
      expect(r.output).toContain('op=setSpeaker');
      expect(await exists(join(dir, 'characters', 'aiko', 'character.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('deletes a character who speaks no line, removing its sheet and folder', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      for (const line of ['arrival:L1', 'ending:L2']) {
        const r = await run('edit_scene', { op: 'setSpeaker', line, speaker: '' }, ctx);
        expect(r.ok).toBe(true);
      }
      const r = await run('delete_character', { character: 'aiko' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toMatch(/^Deleted character aiko\./);
      expect(r.output).not.toContain('Undo');
      expect(r.written).toContain('characters/aiko/character.md');
      expect(await exists(join(dir, 'characters', 'aiko'))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('delete_location', () => {
  it('refuses while a scene is set there, naming the scenes', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('delete_location', { location: 'classroom' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toBe(
        '4 scenes are set at classroom: arrival, ending, greet, observe. Move each one first ' +
          'with edit_scene op=setHeading, then delete the location.',
      );
    } finally {
      await cleanup();
    }
  });

  it('deletes a location no scene is set in', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await fs.writeFile(
        join(dir, 'locations', 'rooftop.md'),
        '---\nid: rooftop\nname: Rooftop\n---\n',
      );
      const r = await run('delete_location', { location: 'rooftop' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toMatch(/^Deleted location rooftop\./);
      expect(await exists(join(dir, 'locations', 'rooftop.md'))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('delete_files', () => {
  it('deletes files under the file roots', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await fs.mkdir(join(dir, 'wiki', 'lore'), { recursive: true });
      await fs.writeFile(join(dir, 'wiki', 'lore', 'a.md'), '# A\n');
      await fs.writeFile(join(dir, 'wiki', 'lore', 'b.md'), '# B\n');
      const r = await run('delete_files', { paths: ['wiki/lore', 'wiki/lore/a.md'] }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toBe('Deleted wiki/lore (2 files).');
      expect(r.written).toEqual(['wiki/lore', 'wiki/lore/a.md', 'wiki/lore/b.md']);
      expect(await exists(join(dir, 'wiki', 'lore'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('refuses a sheet by naming the tool that deletes the entity, and a path outside the roots', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const sheet = await run('delete_files', { paths: ['characters/aiko'] }, ctx);
      expect(sheet.ok).toBe(false);
      expect(sheet.output).toBe(
        'characters/aiko holds characters/aiko/character.md, which is the sheet for character ' +
          'aiko. Delete it with delete_character, which also rewrites what refers to aiko.',
      );
      const scene = await run('delete_files', { paths: ['scenes/arrival.md'] }, ctx);
      expect(scene.ok).toBe(false);
      expect(scene.output).toMatch(/^Files can be created, moved, renamed and deleted only under/);
      expect(await exists(join(dir, 'scenes', 'arrival.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('edit_scene asks before removing a file', () => {
  const side = '---\nscene: side\n---\n\nINT. CLASSROOM - DAY\n\nA side scene.\n';

  it('asks before deleting a scene’s chunk, and writes nothing on a no', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await fs.writeFile(join(dir, 'scenes', 'side.md'), side);
      const asked: string[] = [];
      ctx.confirm = (message) => {
        asked.push(message);
        return Promise.resolve(false);
      };
      const r = await run('edit_scene', { op: 'deleteScene', scene: 'side' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/^Declined:/);
      expect(asked).toEqual([
        'This edit (deleteScene) removes scenes/side.md. Only git history brings it back.',
      ]);
      expect(await fs.readFile(join(dir, 'scenes', 'side.md'), 'utf8')).toBe(side);
    } finally {
      await cleanup();
    }
  });

  it('deletes the scene on a yes', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await fs.writeFile(join(dir, 'scenes', 'side.md'), side);
      ctx.confirm = () => Promise.resolve(true);
      const r = await run('edit_scene', { op: 'deleteScene', scene: 'side' }, ctx);
      expect(r.ok).toBe(true);
      expect(await exists(join(dir, 'scenes', 'side.md'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('refuses with no one to ask, and asks nothing for an edit that removes nothing', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('edit_scene', { op: 'newShot', scene: 'ending', lineIds: ['ending:L1'] }, ctx);
      const r = await run(
        'edit_scene',
        { op: 'deleteShot', scene: 'ending', shot: 'ending__shot1' },
        ctx,
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('there is no one here to ask');
      expect(await exists(join(dir, 'vngen', 'work', 'shots', 'ending.json'))).toBe(true);

      const retyped = await run(
        'edit_scene',
        { op: 'setLineText', line: 'arrival:L1', text: 'Hi.' },
        ctx,
      );
      expect(retyped.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
