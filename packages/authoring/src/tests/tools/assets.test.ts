import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { AssetStore, ProjectPaths } from '@vn/store';
import type { PipelineControl } from '../../index.js';
import { Workspace } from '../../index.js';
import { fakeArt, run, tempProject, tool, LOCATION } from './testkit.js';

/** One rendered plate on disk, so the asset tools have something real to name. */
async function plate(dir: string): Promise<string> {
  const store = await AssetStore.open(new ProjectPaths(dir));
  const ref = await store.write(new TextEncoder().encode('the plate itself'), 'png', {
    kind      : 'location_ref',
    sourceTask: 't'.repeat(64),
    modelId   : 'fake-image',
    satisfies : { locationId: 'classroom', variant: 'day' },
  });
  return ref.hash;
}

/** Records what a tool asked the pipeline for rather than doing what a scheduler would. */
function fakePipeline(): { pipeline: PipelineControl; queued: string[]; ran: () => number } {
  const queued: string[] = [];
  let runs = 0;
  const pipeline: PipelineControl = {
    regenerate: (hash) => {
      queued.push(hash);
      return Promise.resolve({
        ok     : true,
        message: `Queued location_ref ${hash.slice(0, 8)} for re-run.`,
        written: ['vngen/state/tasks.jsonl'],
      });
    },
    run: () => {
      runs += 1;
      return Promise.resolve({ ran: 1, failed: 0, blockedOnGate: false });
    },
  };
  return { pipeline, queued, ran: () => runs };
}

describe('list_assets', () => {
  it('lists what was rendered for a subject, in the project’s own name for it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const r = await run('list_assets', { subject: 'location:classroom' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.output).toContain(hash.slice(0, 12));
      expect(r.output).toContain('classroom — day plate');
      expect(r.output).toContain('[location_ref]');
      // Written straight into the manifest, so nothing has held it: a row a run never filed
      expect(r.data).toEqual([
        {
          hash,
          kind    : 'location_ref',
          label   : 'classroom — day plate',
          current : false,
          approved: false,
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  // "Nothing yet" and "that is not a subject" are different answers, and an agent that cannot
  // tell them apart writes a note on a rung it invented.
  it('separates a subject with nothing rendered from a subject it cannot parse', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await plate(dir);
      const empty = await run('list_assets', { subject: 'character:aiko' }, ctx);
      expect(empty.ok).toBe(true);
      expect(empty.output).toContain('No rendered assets for character:aiko');

      const bad = await run('list_assets', { subject: 'classroom' }, ctx);
      expect(bad.ok).toBe(false);
      expect(bad.output).toContain('is not a subject');
    } finally {
      await cleanup();
    }
  });
});

describe('art_notes and set_art_notes', () => {
  it('reports both rungs a plate answers to, and what each says today', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const before = await run('art_notes', { hash: hash.slice(0, 8) }, ctx);
      expect(before.ok).toBe(true);
      expect(before.data).toEqual([
        { target: 'location:classroom', label: 'Classroom 2-B' },
        { target: 'location:classroom/day', label: 'Classroom 2-B — day' },
      ]);
      expect(before.output).toContain('(nothing authored)');

      const wrote = await run(
        'set_art_notes',
        { target: 'location:classroom/day', notes: 'brutalist concrete' },
        ctx,
      );
      expect(wrote.ok).toBe(true);
      expect(wrote.output).toContain('Appended to art notes on Classroom 2-B — day.');
      expect(wrote.written).toEqual(['locations/classroom.md']);

      const after = await run('art_notes', { hash }, ctx);
      expect(after.output).toContain('brutalist concrete');
      // The other variant is untouched, and the sheet still declares both.
      expect(await fs.readFile(join(dir, 'locations', 'classroom.md'), 'utf8')).toContain(
        'afternoon',
      );
    } finally {
      await cleanup();
    }
  });

  it('appends by default, replaces and clears when told', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await run('set_art_notes', { target: 'location:classroom', notes: 'first' }, ctx);
      await run('set_art_notes', { target: 'location:classroom', notes: 'second' }, ctx);
      const workspace = new Workspace(dir);
      const notesNow = async (): Promise<string | undefined> =>
        (await workspace.load()).model.locations.get('classroom')?.artNotes;
      expect(await notesNow()).toBe('first\nsecond');

      await run(
        'set_art_notes',
        { target: 'location:classroom', notes: 'only this', mode: 'replace' },
        ctx,
      );
      expect(await notesNow()).toBe('only this');

      const cleared = await run(
        'set_art_notes',
        { target: 'location:classroom', mode: 'clear' },
        ctx,
      );
      expect(cleared.output).toContain('Cleared art notes on Classroom 2-B.');
      expect(await notesNow()).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // A note on a variant nobody declared means a typo, and creating the variant would hide it.
  it('refuses a rung that does not exist and a target it cannot parse', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const missing = await run(
        'set_art_notes',
        { target: 'location:classroom/midnight', notes: 'x' },
        ctx,
      );
      expect(missing.ok).toBe(false);
      expect(missing.output).toBe('No such art-notes rung: location:classroom/midnight.');

      const bad = await run('set_art_notes', { target: 'classroom', notes: 'x' }, ctx);
      expect(bad.ok).toBe(false);
      expect(bad.output).toContain('names no art-notes rung');
      expect(await fs.readFile(join(dir, 'locations', 'classroom.md'), 'utf8')).toBe(LOCATION);
    } finally {
      await cleanup();
    }
  });
});

describe('view_image', () => {
  it('resolves a prefix before spending the call, and passes the question through', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const { art, looked } = fakeArt(dir);
      const r = await run(
        'view_image',
        { hash: hash.slice(0, 10), question: 'is it brutalist yet?' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(true);
      expect(looked).toEqual([{ hash, question: 'is it brutalist yet?' }]);
      expect(r.output).toContain('the picture');
    } finally {
      await cleanup();
    }
  });

  it('refuses an asset the store has never rendered, and refuses without a seam', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, looked } = fakeArt(dir);
      const unknown = await run('view_image', { hash: 'f'.repeat(64) }, { ...ctx, art });
      expect(unknown.ok).toBe(false);
      expect(unknown.output).toContain('list_assets');
      expect(looked).toHaveLength(0);

      await plate(dir);
      const bare = await run('view_image', { hash: 'f'.repeat(8) }, ctx);
      expect(bare.ok).toBe(false);
      expect(bare.output).toContain('not available');
      expect(tool('view_image').mutating).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('regenerate_asset', () => {
  // The boundaries rule stops `@vn/authoring` from running a pipeline, so the tool names the host
  // that can rather than failing with something the author cannot act on.
  it('refuses without the capability and names the host that has it', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      await plate(dir);
      const r = await run('regenerate_asset', { hash: 'a'.repeat(8) }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toBe(
        'regenerating a planned asset runs the pipeline, which vnauthor does not do — open the project in the desktop app.',
      );
      expect(tool('regenerate_asset').mutating).toBe(true);
      expect(tool('regenerate_asset').confirm).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('queues alone, and runs only when asked', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const hash = await plate(dir);
      const { pipeline, queued, ran } = fakePipeline();

      const only = await run('regenerate_asset', { hash: hash.slice(0, 10) }, { ...ctx, pipeline });
      expect(only.ok).toBe(true);
      expect(queued).toEqual([hash]);
      expect(ran()).toBe(0);
      expect(only.output).toContain('Nothing is drawn until the pipeline runs.');
      expect(only.written).toEqual(['vngen/state/tasks.jsonl']);

      const now = await run('regenerate_asset', { hash, run: true }, { ...ctx, pipeline });
      expect(ran()).toBe(1);
      expect(now.output).toContain('Ran 1 task(s).');
    } finally {
      await cleanup();
    }
  });
});
