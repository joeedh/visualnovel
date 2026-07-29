import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Logger, Scene } from '@vn/types';
import { canonicalScenes } from '@vn/model';
import { AssetStore, ProjectPaths } from '@vn/store';
import type { Playable } from '@vn/types';
import { makeProject, SCRIPTS } from '@vn/testkit';
import { cmdApprove, cmdExport, cmdImport, cmdRun, type ApproveIO } from '../commands.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

// One scene, one character awaiting approval — the smallest project `cmdApprove` acts on.
const SCRIPT = 'INT. CLASSROOM - DAY\n\n[[scene: arrival]]\n\nAIKO\nHi.\n';

/** A minimal project on disk plus its asset store, ready for `cmdApprove`. */
async function tempProject(): Promise<{
  dir: string;
  store: AssetStore;
  cleanup: () => Promise<void>;
}> {
  const p = await makeProject({
    title: 'Test',
    script: SCRIPT,
    characters: [{ id: 'aiko', name: 'Aiko', status: 'candidates' }],
  });
  return { dir: p.dir, store: (await p.reload()).store, cleanup: () => p.cleanup() };
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

describe('cmdImport', () => {
  /** The model's scenes as one comparable string, ordered so storage order cannot matter. */
  const scenesOf = (scenes: Map<string, Scene>): string =>
    canonicalScenes([...scenes.values()].sort((a, b) => a.id.localeCompare(b.id)));

  it('converts a screenplay project to chunks the model reads back identically', async () => {
    const p = await makeProject({ format: 'screenplay', script: SCRIPTS.branching });
    try {
      const before = await p.reload();
      const beforeTasks = (await p.run({ dryRun: true })).preview;

      const { code, out } = await capture(() => cmdImport({ positional: [p.dir], flags: {} }));
      expect(code).toBe(0);
      expect(out).toContain('Wrote 4 scene chunk(s)');
      expect(out).toContain('start: arrival');

      // The screenplay is still there under a name `loadInputs` does not look at, so the
      // project loads from the chunks alone rather than reporting two input formats.
      expect(await fs.readdir(join(p.dir, 'screenplay'))).toEqual(['script.fountain.imported']);
      expect(await fs.readdir(join(p.dir, 'scenes'))).toEqual([
        'arrival.md',
        'bad_end.md',
        'good_end.md',
        'rooftop.md',
      ]);

      const after = await p.reload();
      expect(after.model.diagnostics).toEqual([]);
      expect(after.config.start).toBe('arrival');
      expect(scenesOf(after.model.scenes)).toBe(scenesOf(before.model.scenes));
      // Nothing a task hashes names a file, so the migration must not move any work.
      expect((await p.run({ dryRun: true })).preview).toEqual(beforeTasks);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('refuses over an existing scenes/ rather than overwriting authored work', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const arrival = await p.read(join('scenes', 'arrival.md'));
      const { code, out } = await capture(() => cmdImport({ positional: [p.dir], flags: {} }));
      expect(code).toBe(1);
      expect(out).toContain('already holds 2 scene chunk(s)');
      expect(out).toContain('there is no --force');
      expect(await p.read(join('scenes', 'arrival.md'))).toBe(arrival);
    } finally {
      await p.cleanup();
    }
  });

  it('reports there is nothing to import when the project has no screenplay', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await fs.rm(join(p.dir, 'scenes'), { recursive: true });
      const { code, out } = await capture(() => cmdImport({ positional: [p.dir], flags: {} }));
      expect(code).toBe(1);
      expect(out).toContain('No screenplay to import');
    } finally {
      await p.cleanup();
    }
  });

  it('touches no file when the conversion cannot be proven', async () => {
    const script = `INT. CLASSROOM - DAY

[[scene: arrival]]

She sets her bag down.

EXT. ROOFTOP - NIGHT

[[scene: arrival]]

The city hums below.
`;
    const p = await makeProject({ format: 'screenplay', script });
    try {
      const { code, out } = await capture(() => cmdImport({ positional: [p.dir], flags: {} }));
      expect(code).toBe(1);
      expect(out).toContain('[import_duplicate_scene]');
      expect(out).toContain('no file was touched');
      expect(await fs.readdir(join(p.dir, 'screenplay'))).toEqual(['script.fountain']);
      await expect(fs.readdir(join(p.dir, 'scenes'))).rejects.toThrow();
      expect(await p.read('project.yaml')).not.toContain('start:');
    } finally {
      await p.cleanup();
    }
  });
});

describe('cmdExport', () => {
  it('writes a playable story.play.json projected from the model', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { code, out } = await capture(() => cmdExport({ positional: [dir], flags: {} }));
      expect(code).toBe(0);
      expect(out).toContain('Exported');
      const playPath = join(dir, 'vngen', 'build', 'story.play.json');
      const play = JSON.parse(await fs.readFile(playPath, 'utf8')) as Playable;
      expect(play.version).toBe(1);
      expect(play.start).toBe('arrival');
      // The single dialogue line is attributed to the resolved character id.
      const say = play.scenes['arrival']!.beats.find((b) => b.type === 'say');
      expect(say).toMatchObject({ type: 'say', who: 'aiko', text: 'Hi.' });
      // No assets were generated, so no image refs leak into the beats.
      expect(play.characters['aiko']!.portrait).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('end to end — on-disk inputs → run → export', () => {
  it('renders with mock providers, then exports refs the store can resolve', async () => {
    const p = await makeProject({ title: 'End to End', script: SCRIPT });
    try {
      expect((await p.run()).blockedOnGate).toBe(true);
      expect(await p.approveAll()).toEqual(['aiko']);
      expect((await p.run()).blockedOnGate).toBe(false);

      const { code } = await capture(() => cmdExport({ positional: [p.dir], flags: {} }));
      expect(code).toBe(0);
      const playPath = join(p.dir, 'vngen', 'build', 'story.play.json');
      const play = JSON.parse(await fs.readFile(playPath, 'utf8')) as Playable;

      const portrait = play.characters['aiko']!.portrait;
      const show = play.scenes['arrival']!.beats.find((b) => b.type === 'show');
      expect(show).toMatchObject({ type: 'show', image: { ext: 'png' } });
      const background = show?.type === 'show' ? show.image : undefined;

      // Every ref the playable hands the runner must be resolvable from the store.
      const { store } = await p.reload();
      expect(store.has(portrait!.hash)).toBe(true);
      expect(store.has(background!.hash)).toBe(true);
    } finally {
      await p.cleanup();
    }
  }, 30_000);
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
