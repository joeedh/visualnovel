import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { run, tempProject } from './testkit.js';

describe('read-only tools', () => {
  it('validate_inputs passes on a valid project', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('validate_inputs', {}, ctx);
      expect(r.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('validate_project passes on a project with no art, and fails on a portrait nobody drew', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const clean = await run('validate_project', {}, ctx);
      expect(clean.ok).toBe(true);
      expect(clean.output).toBe('Validation found no problems.');

      const sheet = join(dir, 'characters', 'aiko', 'character.md');
      const text = await fs.readFile(sheet, 'utf8');
      await fs.writeFile(
        sheet,
        text.replace('id: aiko', `id: aiko\napproved_portrait: ${'a'.repeat(64)}`),
      );
      const broken = await run('validate_project', {}, ctx);
      expect(broken.ok).toBe(false);
      expect(broken.output).toContain("character aiko's approved_portrait");
    } finally {
      await cleanup();
    }
  });

  it('story_graph reports reachability and no dangling edges', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('story_graph', {}, ctx);
      expect(r.output).toContain('Unreachable: none');
      expect(r.output).toContain('Dangling: none');
    } finally {
      await cleanup();
    }
  });

  it('extract_entities reports referenced vs defined', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('extract_entities', {}, ctx);
      expect(r.output).toContain('aiko');
    } finally {
      await cleanup();
    }
  });
});
