import { promises as fs } from 'node:fs';
import type { AnyTask, TaskInputs } from '@vn/types';
import { errors } from '@vn/model';
import { SCRIPTS, makeProject } from '../index.js';

/** Shot ids of the `shot_image` tasks in a run. `Task` is generic, so `inputs` needs a cast. */
const shotIds = (tasks: AnyTask[]): string[] =>
  tasks
    .filter((t) => t.kind === 'shot_image')
    .map((t) => (t.inputs as TaskInputs['shot_image']).shotId);

describe('makeProject — inputs on disk', () => {
  it('builds a project that loads back with no error diagnostics', async () => {
    const p = await makeProject({ title: 'The Transfer Student' });
    try {
      const { config, model } = await p.reload();
      expect(config.title).toBe('The Transfer Student');
      expect(errors(model)).toEqual([]);
      expect(model.entry).toBe('arrival');
      expect([...model.scenes.keys()]).toEqual(['arrival', 'rooftop', 'good_end', 'bad_end']);
    } finally {
      await p.cleanup();
    }
  });

  it('infers characters from cues and locations (with variants) from headings', async () => {
    const p = await makeProject();
    try {
      const { model } = await p.reload();
      expect([...model.characters.keys()].sort()).toEqual(['aiko', 'haruki']);
      // The classroom is used at two times of day; both variants must survive inference.
      expect(model.locations.get('classroom')!.variants.map((v) => v.id)).toEqual([
        'afternoon',
        'evening',
      ]);
      expect(model.locations.get('classroom')!.mined).toBe(false);
      expect(await p.read('locations/rooftop.md')).toContain('id: rooftop');
    } finally {
      await p.cleanup();
    }
  });

  it('honors explicit specs, config overrides and extra files', async () => {
    const p = await makeProject({
      script: SCRIPTS.linear,
      characters: [{ id: 'aiko', name: 'Aiko', status: 'approved', approvedPortrait: 'abc123' }],
      config: { concurrency: 1, art_style: 'ink wash' },
      files: { 'AICONTEXT.md': 'Keep it short.\n' },
    });
    try {
      const { config, model } = await p.reload();
      expect(config.concurrency).toBe(1);
      expect(config.art_style).toBe('ink wash');
      expect(model.characters.get('aiko')!.approvedPortrait).toBe('abc123');
      expect(await p.read('AICONTEXT.md')).toBe('Keep it short.\n');
    } finally {
      await p.cleanup();
    }
  });

  it('reports the unreachable scene in SCRIPTS.orphan', async () => {
    const p = await makeProject({ script: SCRIPTS.orphan });
    try {
      const { model } = await p.reload();
      expect(errors(model)).toEqual([]);
      expect(model.diagnostics.filter((d) => d.code === 'unreachable_scene')).toHaveLength(1);
      expect(model.reachable.has('forgotten')).toBe(false);
    } finally {
      await p.cleanup();
    }
  });

  it('cleans up after itself', async () => {
    const p = await makeProject();
    await p.cleanup();
    await expect(fs.stat(p.dir)).rejects.toThrow();
  });
});

describe('makeProject — scenes as chunks', () => {
  it('writes one file per scene and no screenplay, entry named by start:', async () => {
    const p = await makeProject({ format: 'chunks' });
    try {
      const { config, model } = await p.reload();
      expect(config.start).toBe('arrival');
      expect(errors(model)).toEqual([]);
      expect([...model.scenes.keys()]).toEqual(['arrival', 'bad_end', 'good_end', 'rooftop']);
      expect(model.entry).toBe('arrival');

      const chunk = await p.read('scenes/arrival.md');
      expect(chunk).toContain('scene: arrival');
      // The id lives in front-matter now; a body marker could rename the file it sits in.
      expect(chunk).not.toContain('[[scene:');
      expect(chunk).toContain('INT. CLASSROOM - AFTERNOON');
      await expect(fs.stat(p.paths.screenplayDir)).rejects.toThrow();
    } finally {
      await p.cleanup();
    }
  });

  it('plans byte-identical work either way — the format is storage, not content', async () => {
    const chunks = await makeProject({ format: 'chunks' });
    const screenplay = await makeProject({ format: 'screenplay' });
    try {
      const hashes = async (p: typeof chunks): Promise<string[]> => {
        await p.run();
        await p.approveAll();
        await p.run();
        return (await p.reload()).graph
          .all()
          .map((t) => t.hash)
          .sort();
      };
      // Task identity is sha256(kind, inputs), and the shot prompt is built from `lines`. A
      // scene that survives the split unchanged therefore keys to the same work.
      const fromChunks = await hashes(chunks);
      expect(fromChunks.length).toBeGreaterThan(0);
      expect(fromChunks).toEqual(await hashes(screenplay));
    } finally {
      await chunks.cleanup();
      await screenplay.cleanup();
    }
  }, 60_000);
});

describe('TestProject.run — the gate, end to end on disk', () => {
  it('halts at the character gate, then clears it after approve', async () => {
    const p = await makeProject({ title: 'Gate' });
    try {
      const first = await p.run();
      expect(first.blockedOnGate).toBe(true);
      expect(first.gate.pending).toEqual(['aiko', 'haruki']);
      expect(first.ran.some((t) => t.kind === 'location_ref' && t.status === 'done')).toBe(true);
      expect(first.ran.filter((t) => t.kind === 'portrait')).toHaveLength(2);
      // The barrier is per scene: the two castless endings render before any approval.
      expect(shotIds(first.ran).sort()).toEqual([
        'bad_end__establishing',
        'good_end__establishing',
      ]);

      expect((await p.approveAll()).sort()).toEqual(['aiko', 'haruki']);

      const second = await p.run();
      expect(second.gate.cleared).toBe(true);
      expect(second.blockedOnGate).toBe(false);
      expect(second.ran.some((t) => t.kind === 'model_sheet' && t.status === 'done')).toBe(true);
      expect(shotIds(second.ran)).toContain('arrival__establishing');

      // Everything the run produced is readable back from disk by a fresh load.
      const { model, store, graph } = await p.reload();
      expect(model.characters.get('aiko')!.status).toBe('approved');
      expect(new Set(store.manifest().map((a) => a.kind))).toEqual(
        new Set(['location_ref', 'portrait', 'model_sheet', 'shot_image']),
      );
      expect(graph.all().every((t) => t.status === 'done')).toBe(true);
      await expect(fs.stat(p.paths.approvedPortrait('aiko'))).resolves.toBeDefined();
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('dry-runs without writing any asset', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const summary = await p.run({ dryRun: true });
      expect(summary.ran).toHaveLength(0);
      expect(summary.preview.pendingTasks).toBeGreaterThan(0);
      const { store } = await p.reload();
      expect(store.manifest()).toHaveLength(0);
    } finally {
      await p.cleanup();
    }
  });

  it('refuses to approve a character with no generated portrait', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await expect(p.approve('aiko')).rejects.toThrow(/no portrait asset/);
    } finally {
      await p.cleanup();
    }
  });
});

describe('TestProject — git', () => {
  it('starts clean and scopes a diff to the edited file', async () => {
    const p = await makeProject({ script: SCRIPTS.linear, git: true });
    try {
      expect((await p.git!.status()).dirty).toBe(false);
      expect(await p.diff()).toBe('');

      const script = await p.read('screenplay/script.fountain');
      await p.write('screenplay/script.fountain', script.replace('[[next: rooftop]]', ''));

      const diff = await p.diff('screenplay/');
      expect(diff).toContain('-[[next: rooftop]]');
      expect(await p.diff('characters/')).toBe('');
    } finally {
      await p.cleanup();
    }
  });

  it('throws on diff when the project has no repo', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      expect(p.git).toBeUndefined();
      expect(() => p.diff()).toThrow(/without `git: true`/);
    } finally {
      await p.cleanup();
    }
  });
});
