import { join } from 'node:path';
import { VnError } from '@vn/util';
import type { ConceptListing } from '../../index.js';
import { fakeArt, run, tempProject, tool } from './testkit.js';

describe('generate_image', () => {
  it('refuses without a seam rather than assume a key exists to spend', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('generate_image', { sentence: 'an aerial shot of the school' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('not available');
    } finally {
      await cleanup();
    }
  });

  it('draws, names what it bound to, and stages the bytes with the manifest', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, asked } = fakeArt(dir);
      const r = await run(
        'generate_image',
        { sentence: 'the classroom from above', subject: 'location:classroom' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(true);
      expect(asked).toEqual([
        { sentence: 'the classroom from above', subject: { kind: 'location', id: 'classroom' } },
      ]);
      expect(r.output).toContain('location:classroom');
      expect(r.written).toEqual([`assets/objects/${'f'.repeat(64)}.png`, 'assets/manifest.json']);
    } finally {
      await cleanup();
    }
  });

  it('refuses a subject that is not written as kind:id', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, asked } = fakeArt(dir);
      const r = await run(
        'generate_image',
        { sentence: 'the roof at dusk', subject: 'classroom' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(false);
      expect(r.output).toContain('location:<id>');
      expect(asked).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('passes a refusal from the seam through instead of throwing', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const { art } = fakeArt(ctx.workspace.root);
      art.generate = () =>
        Promise.reject(new VnError('BASE_UNAVAILABLE', 'The base art root is unavailable.'));
      const r = await run('generate_image', { sentence: 'anything' }, { ...ctx, art });
      expect(r.ok).toBe(false);
      expect(r.output).toBe('The base art root is unavailable.');
    } finally {
      await cleanup();
    }
  });

  it('is mutating and always confirmed — it spends money', () => {
    expect(tool('generate_image').mutating).toBe(true);
    expect(tool('generate_image').confirm).toBe(true);
  });
});

describe('list_images', () => {
  it('reads nothing and says so when there is nothing drawn yet', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art } = fakeArt(dir);
      const r = await run('list_images', {}, { ...ctx, art });
      expect(r.ok).toBe(true);
      expect(r.output).toContain('generate_image');
      expect(tool('list_images').mutating).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // The prompt is in the listing because it is the thing `edit_image` starts from: an agent that
  // could not read it would have to invent a whole prompt to change three words of one.
  it('names each sketch, what it is of, and the prompt it was drawn from', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, concepts } = fakeArt(dir);
      concepts.push({
        hash   : 'b'.repeat(64),
        file   : join(dir, 'assets', 'objects', `${'b'.repeat(64)}.png`),
        title  : 'the school from above',
        prompt : 'STYLE. Subject: School. from above',
        subject: { kind: 'location', id: 'classroom' },
      });
      const r = await run('list_images', {}, { ...ctx, art });
      expect(r.ok).toBe(true);
      expect(r.output).toContain('the school from above');
      expect(r.output).toContain('location:classroom');
      expect(r.output).toContain('STYLE. Subject: School. from above');
      expect(r.data).toEqual([
        {
          hash   : 'b'.repeat(64),
          title  : 'the school from above',
          prompt : 'STYLE. Subject: School. from above',
          subject: 'location:classroom',
        },
      ]);
    } finally {
      await cleanup();
    }
  });
});

describe('edit_image', () => {
  const sketch = (dir: string, hash: string): ConceptListing => ({
    hash,
    file  : join(dir, 'assets', 'objects', `${hash}.png`),
    title : 'the school from above',
    prompt: 'STYLE. Subject: School. from above',
  });

  it('draws the edited prompt and says the original is still there', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, redrawn, concepts } = fakeArt(dir);
      concepts.push(sketch(dir, 'b'.repeat(64)));
      const r = await run(
        'edit_image',
        { hash: 'bbbbbbbb', prompt: 'STYLE. Subject: School. from above, at dusk' },
        { ...ctx, art },
      );
      expect(r.ok).toBe(true);
      // The prefix resolved to the whole hash before anything was spent.
      expect(redrawn).toEqual([
        { hash: 'b'.repeat(64), prompt: 'STYLE. Subject: School. from above, at dusk' },
      ]);
      expect(r.output).toContain('is still there');
      expect(r.written).toEqual([`assets/objects/${'a'.repeat(64)}.png`, 'assets/manifest.json']);
    } finally {
      await cleanup();
    }
  });

  // Two sketches under one prefix are ambiguous, and asking costs nothing; guessing costs a
  // generation and produces the wrong picture.
  it('refuses an unknown prefix and an ambiguous one, spending nothing either way', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art, redrawn, concepts } = fakeArt(dir);
      concepts.push(sketch(dir, `bbbb${'1'.repeat(60)}`), sketch(dir, `bbbb${'2'.repeat(60)}`));

      const missing = await run('edit_image', { hash: 'cccc' }, { ...ctx, art });
      expect(missing.ok).toBe(false);
      expect(missing.output).toContain('list_images');

      const both = await run('edit_image', { hash: 'bbbb' }, { ...ctx, art });
      expect(both.ok).toBe(false);
      expect(both.output).toContain('names 2 concepts');
      expect(redrawn).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  // A whole hash goes through untouched so the refusal comes from `redrawConcept`, which is the
  // half that knows a portrait's prompt is derived and names the command that re-renders one.
  it('passes a full hash straight to the seam, refusals and all', async () => {
    const { ctx, dir, cleanup } = await tempProject();
    try {
      const { art } = fakeArt(dir);
      art.redraw = () =>
        Promise.reject(new VnError('NOT_A_CONCEPT', 'Asset 1234abcd is a portrait: …'));
      const r = await run('edit_image', { hash: '1'.repeat(64) }, { ...ctx, art });
      expect(r.ok).toBe(false);
      expect(r.output).toContain('is a portrait');
    } finally {
      await cleanup();
    }
  });

  it('refuses without a seam, and is mutating and always confirmed', async () => {
    const { ctx, cleanup } = await tempProject();
    try {
      const r = await run('edit_image', { hash: 'b'.repeat(64) }, ctx);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('not available');
      expect(tool('edit_image').mutating).toBe(true);
      expect(tool('edit_image').confirm).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
