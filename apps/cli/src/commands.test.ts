import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStore, ProjectPaths } from '@vn/store';
import { cmdApprove } from './commands.js';

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

const portraitMeta = (characterId: string) => ({
  kind: 'portrait' as const,
  sourceTask: `task-${characterId}`,
  modelId: 'mock-image',
  satisfies: { characterId },
});

describe('cmdApprove', () => {
  it('auto-selects the character’s portrait hash from the manifest', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      const ref = await store.write(
        new TextEncoder().encode('aiko-portrait'),
        'png',
        portraitMeta('aiko'),
      );
      const { code, out } = await capture(() =>
        cmdApprove({ positional: ['aiko', dir], flags: {} }),
      );
      expect(code).toBe(0);
      expect(out).toContain(ref.hash);
      const md = await fs.readFile(join(dir, 'characters', 'aiko', 'character.md'), 'utf8');
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
        cmdApprove({ positional: ['aiko', dir], flags: {} }),
      );
      expect(code).toBe(1);
      expect(out).toContain('No generated portrait');
    } finally {
      await cleanup();
    }
  });

  it('asks the user to disambiguate when several portraits exist', async () => {
    const { dir, store, cleanup } = await tempProject();
    try {
      const a = await store.write(new TextEncoder().encode('aiko-1'), 'png', portraitMeta('aiko'));
      const b = await store.write(new TextEncoder().encode('aiko-2'), 'png', portraitMeta('aiko'));
      const { code, out } = await capture(() =>
        cmdApprove({ positional: ['aiko', dir], flags: {} }),
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
