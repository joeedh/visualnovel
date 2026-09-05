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
      // Chunk order is the directory's, i.e. by id: a `scenes/` project has no document order,
      // which is exactly why the entry scene is named in `project.yaml` rather than inferred.
      expect([...model.scenes.keys()]).toEqual(['arrival', 'bad_end', 'good_end', 'rooftop']);
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
      script    : SCRIPTS.linear,
      characters: [{ id: 'aiko', name: 'Aiko', status: 'approved', approvedPortrait: 'abc123' }],
      config    : { concurrency: 1, art_style: 'ink wash' },
      files     : { 'AICONTEXT.md': 'Keep it short.\n' },
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
  it('writes one file per scene and no screenplay by default, entry named by start:', async () => {
    const p = await makeProject();
    try {
      const { config, model } = await p.reload();
      expect(config.start).toBe('arrival');
      expect(errors(model)).toEqual([]);
      expect([...model.scenes.keys()]).toEqual(['arrival', 'bad_end', 'good_end', 'rooftop']);
      expect(model.entry).toBe('arrival');

      const chunk = await p.read('scenes/arrival.md');
      expect(chunk).toContain('scene: arrival');
      // The id lives in front-matter; a body marker could rename the file it sits in.
      expect(chunk).not.toContain('[[scene:');
      expect(chunk).toContain('INT. CLASSROOM - AFTERNOON');
      await expect(fs.stat(p.paths.screenplayDir)).rejects.toThrow();
    } finally {
      await p.cleanup();
    }
  });

  it('writes the unimported screenplay form on request, scenes and all left unread', async () => {
    const p = await makeProject({ format: 'screenplay' });
    try {
      // Before `vngen import` runs, the screenplay is on disk, `scenes/` does not exist, and
      // the model has no scenes.
      const { config, model } = await p.reload();
      expect(config.start).toBeUndefined();
      expect(model.scenes.size).toBe(0);
      expect(errors(model).map((d) => d.code)).toEqual(['legacy_screenplay']);
      expect(errors(model)[0]!.message).toContain('vngen import');
      expect(await p.read('screenplay/script.fountain')).toContain('[[scene: arrival]]');
      await expect(fs.stat(p.paths.scenesDir)).rejects.toThrow();
    } finally {
      await p.cleanup();
    }
  });
});

// `wiki:` files the sheet in the story bible under an entity tag instead of `characters/`.
// Where a sheet lives is the author's filing decision and must not reach the model.
describe('makeProject — a sheet filed in the wiki', () => {
  it('builds the same model as the conventional layout', async () => {
    const conventional = await makeProject({ script: SCRIPTS.linear });
    const wiki = await makeProject({
      script    : SCRIPTS.linear,
      characters: [{ id: 'aiko', wiki: 'cast/aiko' }],
    });
    try {
      const a = await conventional.reload();
      const b = await wiki.reload();
      expect(await wiki.read('wiki/cast/aiko.md')).toContain('type: character');
      expect(b.model.diagnostics).toEqual(a.model.diagnostics);
      expect([...b.model.characters]).toEqual([...a.model.characters]);
    } finally {
      await conventional.cleanup();
      await wiki.cleanup();
    }
  });

  it('is the file approval writes back to', async () => {
    const p = await makeProject({
      script    : SCRIPTS.linear,
      characters: [{ id: 'aiko', wiki: 'cast/aiko' }],
    });
    try {
      expect((await p.run()).gate.pending).toEqual(['aiko']);
      expect(await p.approveAll()).toEqual(['aiko']);

      expect(await p.read('wiki/cast/aiko.md')).toContain('status: approved');
      await expect(fs.stat(p.paths.characterFile('aiko'))).rejects.toThrow();
      const { model } = await p.reload();
      expect(model.characters.get('aiko')!.status).toBe('approved');
    } finally {
      await p.cleanup();
    }
  }, 30_000);
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

      // The real scheduler splits the two roots: base kinds land in `assets/` and shot frames
      // in `vngen/build/`, while one facade still reports the union.
      const base = store.manifest().filter((a) => a.kind !== 'shot_image');
      const shots = store.manifest().filter((a) => a.kind === 'shot_image');
      expect(store.base).toMatchObject({ state: 'ready', count: base.length });
      for (const a of base) {
        expect(store.pathOf(a)).toBe(p.paths.baseAssetFile(a.hash, a.ext));
      }
      for (const a of shots) expect(store.pathOf(a)).toBe(p.paths.assetFile(a.hash, a.ext));
      await expect(fs.stat(p.paths.baseManifest)).resolves.toBeDefined();
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

      const chunk = await p.read('scenes/arrival.md');
      await p.write('scenes/arrival.md', chunk.replace('[[next: rooftop]]', ''));

      const diff = await p.diff('scenes/');
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
