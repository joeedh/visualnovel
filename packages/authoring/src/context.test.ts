import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSystem, isInside, loadContext, updateContext, SYSTEM_PROMPT } from './index.js';

async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-ctx-'));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

describe('loadContext', () => {
  it('returns just the system prompt when no context file exists', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const ctx = await loadContext(dir);
      expect(ctx.systemPrompt).toBe(SYSTEM_PROMPT);
      expect(ctx.projectContext).toBe('');
      expect(ctx.files).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('loads AICONTEXT.md and resolves @import', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await fs.writeFile(join(dir, 'canon.md'), 'Ren never apologizes directly.\n');
      await fs.writeFile(
        join(dir, 'AICONTEXT.md'),
        'Tone: wistful.\n@import ./canon.md\nNaming: lowercase ids.\n',
      );
      const ctx = await loadContext(dir);
      expect(ctx.projectContext).toContain('Tone: wistful.');
      expect(ctx.projectContext).toContain('Ren never apologizes directly.');
      expect(ctx.projectContext).toContain('Naming: lowercase ids.');
      expect(ctx.files).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it('prefers AICONTEXT.md but falls back to CLAUDE.md', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await fs.writeFile(join(dir, 'CLAUDE.md'), 'Fallback guidance.\n');
      const ctx = await loadContext(dir);
      expect(ctx.projectContext).toContain('Fallback guidance.');
    } finally {
      await cleanup();
    }
  });

  it('guards against @import cycles', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await fs.writeFile(join(dir, 'AICONTEXT.md'), 'A\n@import ./b.md\n');
      await fs.writeFile(join(dir, 'b.md'), 'B\n@import ./AICONTEXT.md\n');
      const ctx = await loadContext(dir);
      expect(ctx.projectContext).toContain('A');
      expect(ctx.projectContext).toContain('B');
      // No infinite loop; each file loaded once.
      expect(ctx.files).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });
});

describe('updateContext', () => {
  it('creates AICONTEXT.md and appends rules', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await updateContext(dir, 'Ren never apologizes directly.');
      await updateContext(dir, 'Aiko speaks formally.');
      const text = await fs.readFile(join(dir, 'AICONTEXT.md'), 'utf8');
      expect(text).toContain('- Ren never apologizes directly.');
      expect(text).toContain('- Aiko speaks formally.');
    } finally {
      await cleanup();
    }
  });
});

describe('composeSystem', () => {
  it('appends project context to the system prompt', () => {
    const composed = composeSystem({
      systemPrompt: 'SYS',
      projectContext: 'CTX',
      files: [],
    });
    expect(composed).toContain('SYS');
    expect(composed).toContain('CTX');
  });
});

describe('isInside', () => {
  it('accepts paths within the root and rejects escapes', () => {
    expect(isInside('/work', '/work/characters/a.md')).toBe(true);
    expect(isInside('/work', '/etc/passwd')).toBe(false);
    expect(isInside('/work', '/work/../secret')).toBe(false);
  });
});
