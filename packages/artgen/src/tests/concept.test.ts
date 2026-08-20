/**
 * On-demand concept images: what a sentence produces, what it binds to, and the contract that
 * nothing downstream sees it. A concept has no task node and no place in any plan, so a project
 * that holds one must plan exactly what it planned before.
 */
import { makeProject, SCRIPTS } from '@vn/testkit';
import type { AssetRef, ImageProvider, ImageResult, ProjectModel } from '@vn/types';
import {
  conceptPrompt,
  conceptTitle,
  generateConcept,
  matchSubject,
  redrawConcept,
  redrawOf,
} from '../index.js';

/** An image provider that records what it was asked for and answers deterministically. */
function fakeImage(): { image: ImageProvider; calls: { prompt: string; refs: AssetRef[] }[] } {
  const calls: { prompt: string; refs: AssetRef[] }[] = [];
  const image: ImageProvider = {
    generate: (prompt, refs): Promise<ImageResult> => {
      calls.push({ prompt, refs });
      return Promise.resolve({
        bytes: new TextEncoder().encode(`concept:${calls.length}`),
        ext: 'png',
        modelId: 'fake-image',
      });
    },
    edit: () => Promise.reject(new Error('a concept is generated, never edited')),
  };
  return { image, calls };
}

const model = (locations: [string, string][], characters: [string, string][] = []): ProjectModel =>
  ({
    locations: new Map(
      locations.map(([id, name]) => [id, { id, name, palette: [], variants: [] }]),
    ),
    characters: new Map(characters.map(([id, name]) => [id, { id, name, palette: [] }])),
  }) as unknown as ProjectModel;

describe('conceptTitle', () => {
  it('keeps a short sentence whole', () => {
    expect(conceptTitle('  an aerial shot of the roof  ')).toBe('an aerial shot of the roof');
  });

  it('cuts a long one at a word boundary', () => {
    const title = conceptTitle(
      'an aerial shot of the high school taken from the north east at dawn',
    );
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(49);
    expect('an aerial shot of the high school taken from the north east at dawn').toContain(
      title.slice(0, -1),
    );
  });
});

describe('matchSubject', () => {
  it('picks the place the sentence names', () => {
    const m = model([['rooftop', 'Rooftop']], [['aiko', 'Aiko']]);
    expect(matchSubject(m, 'an aerial shot of the rooftop')).toEqual({
      kind: 'location',
      id: 'rooftop',
    });
  });

  it('lets the longer name win', () => {
    const m = model([
      ['school', 'High School'],
      ['gym', 'High School Gym'],
    ]);
    expect(matchSubject(m, 'the high school gym at night')).toEqual({
      kind: 'location',
      id: 'gym',
    });
  });

  it('ignores an id too short to mean anything', () => {
    expect(matchSubject(model([['hs', 'hs']]), 'the ships at anchor')).toBeUndefined();
  });

  it('is not an error to match nothing', () => {
    expect(matchSubject(model([['rooftop', 'Rooftop']]), 'a rain-slick alley')).toBeUndefined();
  });
});

describe('conceptPrompt', () => {
  it('puts the author’s sentence last, before the framing line', () => {
    const m = model([['rooftop', 'Rooftop']]);
    const prompt = conceptPrompt('at dawn, from above', { kind: 'location', id: 'rooftop' }, m, {
      art_style: 'flat fixture illustration',
    } as never);
    expect(prompt).toContain('Subject: Rooftop.');
    expect(
      prompt.endsWith(
        'at dawn, from above Single illustrated concept frame. No text, no UI, no watermarks.',
      ),
    ).toBe(true);
  });
});

describe('generateConcept', () => {
  it('binds to the place it matched, names itself after the sentence, and lands in the base root', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const { config, model: built, store } = await p.reload();
      const { image, calls } = fakeImage();
      const result = await generateConcept(
        { config, model: built, store, image },
        { sentence: 'an aerial shot of the rooftop at dawn' },
      );

      expect(result.subject).toEqual({ kind: 'location', id: 'rooftop' });
      const asset = store.manifest().find((a) => a.hash === result.ref.hash)!;
      expect(asset.kind).toBe('concept');
      expect(asset.satisfies).toEqual([{ locationId: 'rooftop' }]);
      expect(asset.title).toBe('an aerial shot of the rooftop at dawn');
      expect(asset.accepted).toBe(false);
      // Routing is by kind alone: a concept is authored-side art, so it sits beside the plates.
      expect(store.pathOf(result.ref).startsWith(p.paths.baseObjects)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toBe(result.prompt);
    } finally {
      await p.cleanup();
    }
  });

  it('refuses an empty sentence and a subject the project does not have', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { config, model: built, store } = await p.reload();
      const deps = { config, model: built, store, image: fakeImage().image };
      await expect(generateConcept(deps, { sentence: '   ' })).rejects.toThrow(/empty/i);
      await expect(
        generateConcept(deps, {
          sentence: 'a portrait',
          subject: { kind: 'character', id: 'nobody' },
        }),
      ).rejects.toThrow(/No character "nobody"/);
    } finally {
      await p.cleanup();
    }
  });

  it('changes nothing the next run plans', async () => {
    const hashes = (g: { all(): readonly { hash: string }[] }): string[] =>
      g
        .all()
        .map((t) => t.hash)
        .sort();
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      await p.run();
      const { config, model: built, store, graph } = await p.reload();
      const before = hashes(graph);

      await generateConcept(
        { config, model: built, store, image: fakeImage().image },
        { sentence: 'an aerial shot of the rooftop at dawn' },
      );

      const after = await p.run();
      expect(after.ran).toHaveLength(0);
      expect(hashes((await p.reload()).graph)).toEqual(before);
    } finally {
      await p.cleanup();
    }
    // Two full scheduler passes over a real project on disk need more than jest's default timeout
  }, 30_000);
});

describe('redrawConcept', () => {
  it('draws the edited prompt, keeps the binding, and leaves the original standing', async () => {
    const p = await makeProject({ script: SCRIPTS.branching });
    try {
      const { config, model: built, store } = await p.reload();
      const { image, calls } = fakeImage();
      const deps = { config, model: built, store, image };
      const first = await generateConcept(deps, {
        sentence: 'an aerial shot of the rooftop at dawn',
      });

      const edited = `${first.prompt} Ink-wash linework.`;
      const again = await redrawConcept(deps, { hash: first.ref.hash, prompt: edited });

      expect(again.from).toBe(first.ref.hash);
      expect(again.ref.hash).not.toBe(first.ref.hash);
      expect(calls[1]!.prompt).toBe(edited);
      const asset = store.manifest().find((a) => a.hash === again.ref.hash)!;
      expect(asset.kind).toBe('concept');
      // The binding and the name carry over, because this is the same sketch drawn again
      expect(asset.satisfies).toEqual([{ locationId: 'rooftop' }]);
      expect(asset.title).toBe('an aerial shot of the rooftop at dawn');
      expect(asset.prompt).toBe(edited);
      expect(store.manifest().find((a) => a.hash === first.ref.hash)).toBeDefined();
    } finally {
      await p.cleanup();
    }
  });

  it('renames on request, and re-rolls the recorded prompt when given none', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { config, model: built, store } = await p.reload();
      const { image, calls } = fakeImage();
      const deps = { config, model: built, store, image };
      const first = await generateConcept(deps, { sentence: 'the classroom at dusk' });

      const again = await redrawConcept(deps, { hash: first.ref.hash, title: 'dusk study' });
      expect(calls[1]!.prompt).toBe(first.prompt);
      expect(store.manifest().find((a) => a.hash === again.ref.hash)!.title).toBe('dusk study');
    } finally {
      await p.cleanup();
    }
  });

  it('refuses a planned asset by naming the command that does re-run it', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      await p.run();
      const { config, model: built, store } = await p.reload();
      const portrait = store.manifest().find((a) => a.kind === 'portrait')!.hash;

      const decided = redrawOf(store, { hash: portrait });
      expect(decided).toMatchObject({ ok: false, code: 'NOT_A_CONCEPT' });
      expect(decided.ok === false && decided.reason).toContain('asset.regenerate');
      await expect(
        redrawConcept(
          { config, model: built, store, image: fakeImage().image },
          { hash: portrait },
        ),
      ).rejects.toThrow(/asset\.regenerate/);

      expect(redrawOf(store, { hash: 'nope' })).toMatchObject({ ok: false, code: 'UNKNOWN_ASSET' });
    } finally {
      await p.cleanup();
    }
  }, 30_000);

  it('says a re-roll is a re-roll, and that a fixed seed makes it a pointless one', async () => {
    const p = await makeProject({ script: SCRIPTS.linear });
    try {
      const { config, model: built, store } = await p.reload();
      const first = await generateConcept(
        { config, model: built, store, image: fakeImage().image },
        { sentence: 'the classroom at dusk' },
      );

      const plain = redrawOf(store, { hash: first.ref.hash });
      expect(plain.ok === true && plain.plan.reroll).toBe(true);
      expect(plain.ok === true && plain.plan.note).not.toContain('seed');

      const seeded = redrawOf(store, { hash: first.ref.hash }, { seeded: true });
      expect(seeded.ok === true && seeded.plan.note).toContain('seed');

      const edit = redrawOf(store, { hash: first.ref.hash, prompt: 'something else' });
      expect(edit.ok === true && edit.plan.reroll).toBe(false);
    } finally {
      await p.cleanup();
    }
  });
});
