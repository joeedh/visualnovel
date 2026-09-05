/**
 * Writing an art rung — notes or seed. These run against a real project on disk because what
 * matters is which bytes land where. An entity rung goes through `apply*Edit` into the sheet and a
 * shot rung into `work/shots/<sceneId>.json`, and neither may lose what was sitting beside it.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { readShots, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
import { artNotesOf, artSeedOf, setArtNotes, setArtSeed } from '../setnotes.js';

async function depsOf(p: TestProject) {
  const { config } = await p.reload();
  return { config, paths: p.paths };
}

/** One dressed character, plus a storyboard for the scene carrying a shot rung. */
async function fixture(): Promise<TestProject> {
  const p = await makeProject({
    script    : SCRIPTS.branching,
    characters: [
      { id: 'aiko', outfits: { uniform: 'navy blazer', gala: 'a long green dress' } },
      { id: 'haruki' },
    ],
  });
  const shot: Shot = {
    id         : 's1',
    sceneId    : 'rooftop',
    framing    : 'medium',
    location   : 'rooftop/evening',
    subjects   : [{ characterId: 'aiko' }],
    camera     : 'slow push in',
    coversLines: [],
    status     : 'pending',
  };
  await writeShots(p.paths, 'rooftop', [shot]);
  return p;
}

describe('artNotesOf', () => {
  it('refuses a target that names no rung, and one whose rung is not there', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      expect(await artNotesOf(deps, { target: 'scene:rooftop', notes: 'x' })).toMatchObject({
        code  : 'BAD_TARGET',
        reason: expect.stringContaining('names no art-notes rung'),
      });
      expect(await artNotesOf(deps, { target: 'character:aiko/tuxedo', notes: 'x' })).toMatchObject(
        {
          code  : 'NO_SUCH_RUNG',
          reason: 'No such art-notes rung: character:aiko/tuxedo.',
        },
      );
      expect(await artNotesOf(deps, { target: 'shot:rooftop/s9', notes: 'x' })).toMatchObject({
        code: 'NO_SUCH_RUNG',
      });
    } finally {
      await p.cleanup();
    }
  });

  it('says what it would do, in the words the act uses', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      const note = async (target: string, notes: string, mode?: 'append' | 'clear') => {
        const decided = await artNotesOf(deps, {
          target,
          notes,
          ...(mode ? { mode } : {}),
        });
        return decided.ok ? decided.plan.note : decided.reason;
      };
      expect(await note('character:aiko', 'soft key light')).toBe('Set art notes on Aiko.');
      expect(await note('character:aiko', '')).toBe('Cleared art notes on Aiko.');
      expect(await note('character:aiko', 'more', 'append')).toBe('Appended to art notes on Aiko.');
      expect(await note('character:aiko', 'anything', 'clear')).toBe('Cleared art notes on Aiko.');
      expect(await note('shot:rooftop/s1', 'wider')).toBe('Set art notes on rooftop · s1.');
    } finally {
      await p.cleanup();
    }
  });
});

describe('setArtNotes', () => {
  it('writes an entity rung into the sheet the model was built from', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      const plan = await setArtNotes(deps, { target: 'character:aiko', notes: 'soft key light' });
      expect(plan.file).toContain('aiko');
      const { model } = await p.reload();
      expect(model.characters.get('aiko')?.artNotes).toBe('soft key light');
    } finally {
      await p.cleanup();
    }
  });

  // The wardrobe is replaced wholesale by `applyCharacterEdit`, so the rung has to resend it, or a
  // note on one outfit erases the description of another.
  it('leaves the rest of the wardrobe exactly as it was', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      await setArtNotes(deps, { target: 'character:aiko/gala', notes: 'satin, matte' });
      const { model } = await p.reload();
      const outfits = model.characters.get('aiko')?.outfits ?? [];
      expect(outfits.map((o) => [o.id, o.description, o.artNotes])).toEqual([
        ['uniform', 'navy blazer', undefined],
        ['gala', 'a long green dress', 'satin, matte'],
      ]);
    } finally {
      await p.cleanup();
    }
  });

  it('writes a variant rung and keeps the variants beside it', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      await setArtNotes(deps, { target: 'location:rooftop/evening', notes: 'sodium streetlight' });
      const { model } = await p.reload();
      expect(model.locations.get('rooftop')?.variants).toEqual([
        { id: 'evening', description: '', artNotes: 'sodium streetlight' },
      ]);
    } finally {
      await p.cleanup();
    }
  });

  it('writes a shot rung into the storyboard, leaving the authored half alone', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      const plan = await setArtNotes(deps, { target: 'shot:rooftop/s1', notes: 'wider' });
      expect(plan.file).toBe(p.paths.shotsFile('rooftop'));
      const loaded = await readShots(p.paths, 'rooftop');
      expect(loaded?.shots[0]).toMatchObject({
        id      : 's1',
        camera  : 'slow push in',
        artNotes: 'wider',
      });
    } finally {
      await p.cleanup();
    }
  });

  it('appends to what is there, and clears it again', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      const notes = async () => (await p.reload()).model.characters.get('aiko')?.artNotes;

      await setArtNotes(deps, { target: 'character:aiko', notes: 'soft key light' });
      await setArtNotes(deps, { target: 'character:aiko', notes: 'shallow depth', mode: 'append' });
      expect(await notes()).toBe('soft key light\nshallow depth');

      await setArtNotes(deps, { target: 'character:aiko', notes: '', mode: 'clear' });
      expect(await notes()).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  });

  it('throws the refusal it would have shown', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      await expect(setArtNotes(deps, { target: 'character:nobody', notes: 'x' })).rejects.toThrow(
        'No such art-notes rung',
      );
    } finally {
      await p.cleanup();
    }
  });
});

describe('the seed half', () => {
  it('refuses a value an image backend cannot take, before it looks the rung up', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      const bad = async (seed: number) => await artSeedOf(deps, { target: 'character:aiko', seed });
      expect(await bad(-1)).toMatchObject({ code: 'BAD_SEED' });
      expect(await bad(1.5)).toMatchObject({
        code  : 'BAD_SEED',
        reason: '"1.5" is not a seed; expected a whole number of 0 or more.',
      });
      // 0 is a seed like any other; only `null` clears one.
      expect(await artSeedOf(deps, { target: 'character:aiko', seed: 0 })).toMatchObject({
        ok: true,
      });
    } finally {
      await p.cleanup();
    }
  });

  it('shares the rung refusals with the notes half', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      expect(await artSeedOf(deps, { target: 'scene:rooftop', seed: 1 })).toMatchObject({
        code: 'BAD_TARGET',
      });
      expect(await artSeedOf(deps, { target: 'character:aiko/tuxedo', seed: 1 })).toMatchObject({
        code  : 'NO_SUCH_RUNG',
        reason: 'No such art-notes rung: character:aiko/tuxedo.',
      });
    } finally {
      await p.cleanup();
    }
  });

  it('writes a seed at each of the two files, and clears it back to inheriting', async () => {
    const p = await fixture();
    try {
      const deps = await depsOf(p);
      const seedOf = async () => (await p.reload()).model.characters.get('aiko')?.seed;

      const plan = await setArtSeed(deps, { target: 'character:aiko/gala', seed: 0 });
      expect(plan.note).toBe('Set Aiko — gala to seed 0.');
      expect((await p.reload()).model.characters.get('aiko')?.outfits[1]?.seed).toBe(0);

      await setArtSeed(deps, { target: 'character:aiko', seed: 42 });
      expect(await seedOf()).toBe(42);
      await setArtSeed(deps, { target: 'character:aiko', seed: null });
      expect(await seedOf()).toBeUndefined();

      const shot = await setArtSeed(deps, { target: 'shot:rooftop/s1', seed: 9 });
      expect(shot.file).toBe(p.paths.shotsFile('rooftop'));
      // The seed is one field beside the authored half of the shot, and that half has to survive.
      expect((await readShots(p.paths, 'rooftop'))?.shots[0]).toMatchObject({
        camera: 'slow push in',
        seed  : 9,
      });
      await setArtSeed(deps, { target: 'shot:rooftop/s1', seed: null });
      expect((await readShots(p.paths, 'rooftop'))?.shots[0]?.seed).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  });
});
