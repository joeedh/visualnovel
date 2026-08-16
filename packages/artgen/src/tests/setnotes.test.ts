/**
 * Writing an art-notes rung. A real project on disk, because the point of this file is which
 * bytes land where: an entity rung goes through `apply*Edit` into the sheet, a shot rung into
 * `work/shots/<sceneId>.json`, and neither may quietly lose what was sitting beside it.
 */
import { SCRIPTS, makeProject, type TestProject } from '@vn/testkit';
import { readShots, writeShots } from '@vn/store';
import type { Shot } from '@vn/types';
import { artNotesOf, setArtNotes } from '../setnotes.js';

async function depsOf(p: TestProject) {
  const { config } = await p.reload();
  return { config, paths: p.paths };
}

/** The fixture: one dressed character, and a storyboard for the scene with a shot rung. */
async function fixture(): Promise<TestProject> {
  const p = await makeProject({
    script: SCRIPTS.branching,
    characters: [
      { id: 'aiko', outfits: { uniform: 'navy blazer', gala: 'a long green dress' } },
      { id: 'haruki' },
    ],
  });
  const shot: Shot = {
    id: 's1',
    sceneId: 'rooftop',
    framing: 'medium',
    location: 'rooftop/evening',
    subjects: [{ characterId: 'aiko' }],
    camera: 'slow push in',
    coversLines: [],
    status: 'pending',
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
        code: 'BAD_TARGET',
        reason: expect.stringContaining('names no art-notes rung'),
      });
      expect(await artNotesOf(deps, { target: 'character:aiko/tuxedo', notes: 'x' })).toMatchObject(
        {
          code: 'NO_SUCH_RUNG',
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

  // The wardrobe is replaced wholesale by `applyCharacterEdit`, so the rung has to resend it —
  // this is the test that a note on one outfit does not erase the description of another.
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
        id: 's1',
        camera: 'slow push in',
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
