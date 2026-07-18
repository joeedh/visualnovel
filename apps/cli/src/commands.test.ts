import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@vn/types';
import { AssetStore, ProjectPaths } from '@vn/store';
import { cmdApprove, cmdRun, type ApproveIO } from './commands.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** A minimal project on disk plus its asset store, ready for `cmdApprove`. */
async function tempProject(): Promise<{
  dir: string;
  store: AssetStore;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-cli-'));
  await fs.mkdir(join(dir, 'characters', 'aiko'), { recursive: true });
  await fs.mkdir(join(dir, 'screenplay'), { recursive: true });
  await fs.writeFile(join(dir, 'project.yaml'), 'title: Test\n');
  await fs.writeFile(
    join(dir, 'characters', 'aiko', 'character.md'),
    '---\nid: aiko\nname: Aiko\nstatus: candidates\n---\n\nAiko.\n',
  );
  await fs.writeFile(
    join(dir, 'screenplay', 'script.fountain'),
    'Title: Test\n\nINT. CLASSROOM - DAY\n\n[[scene: arrival]]\n\nAIKO\nHi.\n',
  );
  const store = await AssetStore.open(new ProjectPaths(dir));
  return { dir, store, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Run a command, capturing everything it writes to stdout. */
async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => (lines.push(String(chunk)), true));
  try {
    const code = await run();
    return { code, out: lines.join('') };
  } finally {
    spy.mockRestore();
  }
}

/** A scripted {@link ApproveIO}: feeds fixed answers, records prompts + output. */
function scriptIO(answers: string[]): { io: ApproveIO; out: () => string } {
  const lines: string[] = [];
  let i = 0;
  const io: ApproveIO = {
    ask: (q) => (lines.push(q), Promise.resolve(answers[i++] ?? '')),
    write: (l) => void lines.push(l),
  };
  return { io, out: () => lines.join('\n') };
}

const portraitMeta = (characterId: string) => ({
  kind: 'portrait' as const,
  sourceTask: `task-${characterId}-${Math.random()}`,
  modelId: 'mock-image',
  satisfies: { characterId },
});

const readChar = (dir: string): Promise<string> =>
  fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');

describe('cmdRun --mock (dry run)', () => {
  it('previews planned work and writes no assets', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { code, out } = await capture(() =>
        cmdRun({ positional: [dir], flags: { mock: true } }, silentLogger),
      );
      expect(code).toBe(0);
      expect(out).toContain('Dry run');
      const store = await AssetStore.open(new ProjectPaths(dir));
      expect(store.manifest()).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe('cmdApprove — single character (--character)', () => {
  it('auto-selects the portrait hash from the manifest', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      const ref = await store.write(
        new TextEncoder().encode('aiko-portrait'),
        'png',
        portraitMeta('aiko'),
      );
      const { code, out } = await capture(() =>
        cmdApprove({ positional: [dir], flags: { character: 'aiko' } }),
      );
      expect(code).toBe(0);
      expect(out).toContain(ref.hash);
      const md = await readChar(dir);
      expect(md).toContain('status: approved');
      expect(md).toContain(`approved_portrait: ${ref.hash}`);
    } finally {
      await cleanup();
    }
  });

  it('errors when the character has no generated portrait yet', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { code, out } = await capture(() =>
        cmdApprove({ positional: [dir], flags: { character: 'aiko' } }),
      );
      expect(code).toBe(1);
      expect(out).toContain('No generated portrait');
    } finally {
      await cleanup();
    }
  });

  it('asks to disambiguate when several portraits exist', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      const a = await store.write(new TextEncoder().encode('aiko-1'), 'png', portraitMeta('aiko'));
      const b = await store.write(new TextEncoder().encode('aiko-2'), 'png', portraitMeta('aiko'));
      const { code, out } = await capture(() =>
        cmdApprove({ positional: [dir], flags: { character: 'aiko' } }),
      );
      expect(code).toBe(1);
      expect(out).toContain('Multiple portraits');
      expect(out).toContain(a.hash);
      expect(out).toContain(b.hash);
    } finally {
      await cleanup();
    }
  });
});

describe('cmdApprove — interactive (no character)', () => {
  it('walks each pending character and approves on a yes', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      const ref = await store.write(
        new TextEncoder().encode('aiko-portrait'),
        'png',
        portraitMeta('aiko'),
      );
      const { io, out } = scriptIO(['y']);
      const code = await cmdApprove({ positional: [dir], flags: {} }, io);
      expect(code).toBe(0);
      expect(out()).toContain('awaiting approval');
      const md = await readChar(dir);
      expect(md).toContain('status: approved');
      expect(md).toContain(`approved_portrait: ${ref.hash}`);
    } finally {
      await cleanup();
    }
  });

  it('skips a character when the user declines', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      await store.write(new TextEncoder().encode('aiko-portrait'), 'png', portraitMeta('aiko'));
      const { io } = scriptIO(['n']);
      const code = await cmdApprove({ positional: [dir], flags: {} }, io);
      expect(code).toBe(0);
      expect(await readChar(dir)).toContain('status: candidates');
    } finally {
      await cleanup();
    }
  });

  it('prompts for the candidate when several exist and honors the choice', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      await store.write(new TextEncoder().encode('aiko-1'), 'png', portraitMeta('aiko'));
      const b = await store.write(new TextEncoder().encode('aiko-2'), 'png', portraitMeta('aiko'));
      // Choose candidate 2, then confirm.
      const { io } = scriptIO(['2', 'y']);
      const code = await cmdApprove({ positional: [dir], flags: {} }, io);
      expect(code).toBe(0);
      expect(await readChar(dir)).toContain(`approved_portrait: ${b.hash}`);
    } finally {
      await cleanup();
    }
  });

  it('reports nothing to do when the gate is already clear', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      await store.write(new TextEncoder().encode('p'), 'png', portraitMeta('aiko'));
      await capture(() => cmdApprove({ positional: [dir], flags: { character: 'aiko' } })); // clear it
      const { code, out } = await capture(() => cmdApprove({ positional: [dir], flags: {} }));
      expect(code).toBe(0);
      expect(out).toContain('Nothing to approve');
    } finally {
      await cleanup();
    }
  });
});
