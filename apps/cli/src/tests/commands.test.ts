import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Logger, Providers, Scene } from '@vn/types';
import { createMockProviders, type ImageBackend } from '@vn/providers';
import { canonicalScenes, sceneChunksFromScript } from '@vn/model';
import { parseFountain } from '@vn/parse';
import { AssetStore, ProjectPaths } from '@vn/store';
import type { Playable } from '@vn/types';
import { makeProject, SCRIPTS } from '@vn/testkit';
import {
  cmdApprove,
  cmdDecompose,
  cmdExport,
  cmdImport,
  cmdRun,
  cmdScreenplay,
  parseArgs,
  type ApproveIO,
} from '../commands.js';

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

describe('cmdRun — a failure is not a clean run', () => {
  /** Mock providers wired to a real store, so refs resolve exactly as a real run's would. */
  const providersFor = (store: AssetStore, imageBackend?: ImageBackend): Providers =>
    createMockProviders({
      refLoader: async (ref) => ({ bytes: await store.read(ref), ext: ref.ext }),
      ...(imageBackend ? { imageBackend } : {}),
    });

  /** An image backend that rejects every call, so a provider outage is deterministic. */
  const brokenImages = (message: string): ImageBackend => ({
    modelId: 'broken-image',
    generate: () => Promise.reject(new Error(message)),
    edit: () => Promise.reject(new Error(message)),
  });

  const runIn = (dir: string, providers: Providers) =>
    capture(() => cmdRun({ positional: [dir], flags: {} }, silentLogger, providers));

  it('exits 1, names the reason, and says the next run will retry', async () => {
    const p = await makeProject({
      title: 'Test',
      script: SCRIPT,
      characters: [{ id: 'aiko', name: 'Aiko', status: 'candidates' }],
    });
    try {
      const store = (await p.reload()).store;
      const broken = await runIn(p.dir, providersFor(store, brokenImages('the model exploded')));
      expect(broken.code).toBe(1);
      expect(broken.out).toContain('Failed tasks:');
      expect(broken.out).toContain('the model exploded');
      expect(broken.out).toContain('will be retried by the next `vngen run`');

      // The next run inherits the failure, requeues it, and only then reports a clean gate halt.
      const retried = await runIn(p.dir, providersFor((await p.reload()).store));
      expect(retried.code).toBe(0);
      expect(retried.out).toContain('retried from an earlier run:');
      expect(retried.out).not.toContain('Failed tasks:');
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('still reports a clean run as clean', async () => {
    const p = await makeProject({
      title: 'Test',
      script: SCRIPT,
      characters: [{ id: 'aiko', name: 'Aiko', status: 'candidates' }],
    });
    try {
      const first = await runIn(p.dir, providersFor((await p.reload()).store));
      expect(first.code).toBe(0);
      expect(first.out).toContain('Halted at the character-approval gate');
      expect(first.out).not.toContain('failed:');

      await p.approveAll();
      const second = await runIn(p.dir, providersFor((await p.reload()).store));
      expect(second.code).toBe(0);
      expect(second.out).toContain('Gate cleared — all reachable shots generated.');
    } finally {
      await p.cleanup();
    }
  }, 30_000);
});

describe('cmdImport', () => {
  /** The model's scenes as one comparable string, ordered so storage order cannot matter. */
  const scenesOf = (scenes: Map<string, Scene>): string =>
    canonicalScenes([...scenes.values()].sort((a, b) => a.id.localeCompare(b.id)));

  it('converts an unimported screenplay project into the scenes it describes', async () => {
    const p = await makeProject({ format: 'screenplay', script: SCRIPTS.branching });
    try {
      // Before the import the project has no scenes at all — the screenplay is named, not read.
      const before = await p.reload();
      expect(before.model.scenes.size).toBe(0);
      expect(before.model.diagnostics.map((d) => d.code)).toEqual(['legacy_screenplay']);

      const { code, out } = await capture(() => cmdImport({ positional: [p.dir], flags: {} }));
      expect(code).toBe(0);
      expect(out).toContain('Wrote 4 scene chunk(s)');
      expect(out).toContain('start: arrival');

      // The screenplay is still there under a name `loadInputs` does not look at, so nothing is
      // left for it to report and the project loads from the chunks alone.
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
      expect(after.model.entry).toBe('arrival');
      expect([...after.model.scenes.keys()].sort()).toEqual([
        'arrival',
        'bad_end',
        'good_end',
        'rooftop',
      ]);
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('plans byte-identical work to the same story authored as chunks', async () => {
    const imported = await makeProject({ format: 'screenplay', script: SCRIPTS.branching });
    const authored = await makeProject({ script: SCRIPTS.branching });
    try {
      expect((await capture(() => cmdImport({ positional: [imported.dir], flags: {} }))).code).toBe(
        0,
      );
      // Task identity is sha256(kind, inputs) and names no file, so a project that was imported
      // and one that was written as chunks by hand must key to exactly the same work.
      const hashes = async (p: typeof authored): Promise<string[]> => {
        await p.run();
        await p.approveAll();
        await p.run();
        return (await p.reload()).graph
          .all()
          .map((t) => t.hash)
          .sort();
      };
      const fromImport = await hashes(imported);
      expect(fromImport.length).toBeGreaterThan(0);
      expect(fromImport).toEqual(await hashes(authored));
      expect(scenesOf((await imported.reload()).model.scenes)).toBe(
        scenesOf((await authored.reload()).model.scenes),
      );
    } finally {
      await imported.cleanup();
      await authored.cleanup();
    }
  }, 90_000);

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

describe('parseArgs', () => {
  it('reads a short flag value from the next argument, and `-` as that value', () => {
    expect(parseArgs(['dir', '-o', 'out.fountain'])).toEqual({
      positional: ['dir'],
      flags: { o: 'out.fountain' },
    });
    expect(parseArgs(['-o', '-', '--clean'])).toEqual({
      positional: [],
      flags: { o: '-', clean: true },
    });
    expect(parseArgs(['-o=out.fountain'])).toEqual({
      positional: [],
      flags: { o: 'out.fountain' },
    });
  });

  it('leaves an unlisted short flag a boolean and a bare `-` a positional', () => {
    expect(parseArgs(['-x', 'dir'])).toEqual({ positional: ['dir'], flags: { x: true } });
    expect(parseArgs(['-'])).toEqual({ positional: ['-'], flags: {} });
  });
});

describe('cmdScreenplay', () => {
  it('writes one screenplay at the project root that imports back to the same scenes', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const { code, out } = await capture(() => cmdScreenplay({ positional: [p.dir], flags: {} }));
      expect(code).toBe(0);
      expect(out).toContain('Wrote 4 scene(s)');
      const text = await p.read('screenplay.fountain');

      // The markers come out in reading order, and the file is still an input this repo accepts
      expect(text.match(/\[\[scene: (\S+)\]\]/g)).toEqual([
        '[[scene: arrival]]',
        '[[scene: rooftop]]',
        '[[scene: good_end]]',
        '[[scene: bad_end]]',
      ]);
      const { model } = await p.reload();
      const chunks = sceneChunksFromScript(parseFountain(text));
      expect(chunks.diagnostics).toEqual([]);
      expect(chunks.chunks.map((c) => c.id).sort()).toEqual([...model.scenes.keys()].sort());
    } finally {
      await p.cleanup();
    }
  });

  it('writes to stdout for -o -, and to an explicit path otherwise', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { code, out } = await capture(() =>
        cmdScreenplay({ positional: [p.dir], flags: { o: '-' } }),
      );
      expect(code).toBe(0);
      expect(out).toContain('INT. CLASSROOM - DAY');
      expect(out).not.toContain('Wrote');
      await expect(fs.stat(join(p.dir, 'screenplay.fountain'))).rejects.toThrow();

      const elsewhere = join(p.dir, 'reading-copy.fountain');
      await capture(() => cmdScreenplay({ positional: [p.dir], flags: { o: elsewhere } }));
      expect(await fs.readFile(elsewhere, 'utf8')).toBe(out);
    } finally {
      await p.cleanup();
    }
  });

  it('drops the markers under --clean', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { code } = await capture(() =>
        cmdScreenplay({ positional: [p.dir], flags: { clean: true } }),
      );
      expect(code).toBe(0);
      const text = await p.read('screenplay.fountain');
      expect(text).not.toContain('[[');
      expect(text).toContain('INT. CLASSROOM - DAY');
    } finally {
      await p.cleanup();
    }
  });

  it('refuses to write into screenplay/, where the project would keep reporting it', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const target = join(p.dir, 'screenplay', 'again.fountain');
      const { code, out } = await capture(() =>
        cmdScreenplay({ positional: [p.dir], flags: { o: target } }),
      );
      expect(code).toBe(1);
      expect(out).toContain('Refusing to write into');
      await expect(fs.stat(target)).rejects.toThrow();
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

/**
 * The one behaviour worth pinning here is the refusal. Every other path in `cmdDecompose` calls a
 * real text model, which `decomposeall.test.ts` covers over `decomposeAll` directly.
 */
describe('cmdDecompose', () => {
  it('refuses --mock by name, because the baseline it would write wins forever', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      const { code, out } = await capture(() =>
        cmdDecompose(parseArgs(['--mock', dir]), silentLogger),
      );
      expect(code).toBe(1);
      expect(out).toContain('--mock');
      expect(out).toContain('never written');
      // Nothing was written, so `vngen run` still decomposes per scene the way it always has.
      await expect(fs.readdir(join(dir, 'vngen', 'work', 'shots'))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('names the key source, never a value, when there is no text key to reach a model with', async () => {
    const { dir, cleanup } = await tempProject();
    const saved = { ...process.env };
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['CLAUDE_API_KEY'];
    try {
      await expect(cmdDecompose(parseArgs([dir]), silentLogger)).rejects.toThrow(/anthropic/i);
    } finally {
      process.env = saved;
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
