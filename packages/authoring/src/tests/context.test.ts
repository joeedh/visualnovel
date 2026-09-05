import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeSystem,
  isInside,
  loadContext,
  updateContext,
  GENERATED_BANNER,
  GENERATED_CONTEXT_FILE,
  SYSTEM_PROMPT,
} from '../index.js';
import { BRANCH_MARKER_KINDS } from '@vn/parse';

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

  it('loads the generated map as its own section, and the author overrides it', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await fs.writeFile(
        join(dir, GENERATED_CONTEXT_FILE),
        `${GENERATED_BANNER}\n\n# Project map\n\n- aiko "Aiko" [draft]\n`,
      );
      await fs.writeFile(join(dir, 'AICONTEXT.md'), 'Aiko is always called Aiko-san.\n');
      const ctx = await loadContext(dir);
      expect(ctx.generatedContext).toContain('- aiko "Aiko" [draft]');
      // The map is its own section and never lands inside the author's context
      expect(ctx.projectContext).toBe('Aiko is always called Aiko-san.');
      expect(ctx.files).toHaveLength(2);

      const composed = composeSystem(ctx);
      expect(composed.indexOf('PROJECT MAP')).toBeLessThan(composed.indexOf('PROJECT CONTEXT'));
      expect(composed).toContain('AICONTEXT.md overrides it');
    } finally {
      await cleanup();
    }
  });

  it('ignores a file at the generated path that nobody generated', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await fs.writeFile(join(dir, GENERATED_CONTEXT_FILE), 'Hand-written, no banner.\n');
      const ctx = await loadContext(dir);
      expect(ctx.generatedContext).toBe('');
      expect(ctx.files).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('does not inline the generated file through an @import', async () => {
    const { dir, cleanup } = await tempDir();
    try {
      await fs.writeFile(join(dir, GENERATED_CONTEXT_FILE), `${GENERATED_BANNER}\n\nTHE MAP\n`);
      await fs.writeFile(
        join(dir, 'AICONTEXT.md'),
        `Tone: wistful.\n@import ./${GENERATED_CONTEXT_FILE}\n`,
      );
      const ctx = await loadContext(dir);
      expect(ctx.projectContext).not.toContain('THE MAP');
      expect(ctx.generatedContext).toContain('THE MAP');
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
      systemPrompt    : 'SYS',
      projectContext  : 'CTX',
      generatedContext: '',
      files           : [],
    });
    expect(composed).toContain('SYS');
    expect(composed).toContain('CTX');
    expect(composed).not.toContain('PROJECT MAP');
  });
});

describe('SYSTEM_PROMPT', () => {
  // Proves each marker kind is mentioned. The failure this was written for is a kind added to
  // BranchMarker with no row added to the prompt's table. A row that goes stale rather than
  // missing is residual risk no test can reach
  it('names every branch-marker kind', () => {
    for (const kind of BRANCH_MARKER_KINDS) {
      expect(SYSTEM_PROMPT).toContain(`[[${kind}:`);
    }
  });

  // The budget is in characters rather than tokens, the same unit the generated map (8,000) and a
  // bible query (4,000) use. Overflow fails the build rather than truncating, because the prompt
  // is the first segment of a byte-stable cached prefix and cannot be quietly trimmed.
  it('stays inside its character budget', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThanOrEqual(25_000);
  });
});

describe('isInside', () => {
  it('accepts paths within the root and rejects escapes', () => {
    expect(isInside('/work', '/work/characters/a.md')).toBe(true);
    expect(isInside('/work', '/etc/passwd')).toBe(false);
    expect(isInside('/work', '/work/../secret')).toBe(false);
  });
});
