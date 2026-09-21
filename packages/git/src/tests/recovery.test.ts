import {
  checkpointNamed,
  DIRTY_TREE,
  entryOf,
  previewCheckpoint,
  previewGoBack,
  previewTakeBack,
} from '../index.js';
import { tempRepo, write } from './helpers.js';

/** Three saves on one file, the first also adding a second file. */
async function seeded() {
  const repo = await tempRepo();
  const { git, dir } = repo;
  await write(dir, 'a.txt', 'one\n');
  await write(dir, 'b.txt', 'b\n');
  const first = (await git.commit({ message: 'First', paths: ['-A'] }))!;
  await write(dir, 'a.txt', 'two\n');
  const second = (await git.commit({ message: 'Second', paths: ['-A'] }))!;
  await write(dir, 'a.txt', 'three\n');
  const third = (await git.commit({ message: 'Third', paths: ['-A'] }))!;
  return { ...repo, first, second, third };
}

describe('entryOf', () => {
  it('answers a full or abbreviated sha, and nothing for a sha nobody has', async () => {
    const { git, second, cleanup } = await seeded();
    try {
      expect((await entryOf(git, second))?.subject).toBe('Second');
      expect((await entryOf(git, second.slice(0, 8)))?.sha).toBe(second);
      expect(await entryOf(git, '0'.repeat(40))).toBeUndefined();
      expect((await entryOf(git, 'HEAD'))?.subject).toBe('Third');
      expect(await entryOf(git, '')).toBeUndefined();
      expect(await entryOf(git, '--output=x')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('previewTakeBack', () => {
  it('accepts the newest save with a count, and refuses one a later save wrote over', async () => {
    const { git, dir, first, second, third, cleanup } = await seeded();
    try {
      expect(await previewTakeBack(git, third)).toMatchObject({
        ok  : true,
        note: 'Reverses 1 file as a new save. Nothing in history is deleted.',
      });
      expect(await previewTakeBack(git, second)).toEqual({
        ok    : false,
        reason:
          'a.txt was changed again in 1 later save; go back to a save instead, or bring back the file.',
      });
      expect(await previewTakeBack(git, first)).toMatchObject({
        ok    : false,
        reason: expect.stringContaining('first save'),
      });
      expect(await previewTakeBack(git, '0'.repeat(40))).toEqual({
        ok    : false,
        reason: 'No save 0000000 in this repository.',
      });
      expect(await git.isDirty()).toBe(false);

      await write(dir, 'b.txt', 'edited\n');
      expect(await previewTakeBack(git, third)).toEqual({ ok: false, reason: DIRTY_TREE });
      // The app's own logs are not the author's dirt
      await write(dir, 'b.txt', 'b\n');
      await write(dir, 'vngen/state/commands.jsonl', '{}\n');
      expect((await previewTakeBack(git, third)).ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('previewGoBack', () => {
  it('counts the files that move, and refuses HEAD and a dirty tree', async () => {
    const { git, dir, first, third, cleanup } = await seeded();
    try {
      expect(await previewGoBack(git, first)).toMatchObject({
        ok   : true,
        paths: ['a.txt'],
        note: 'Restores 1 file to how it was at that save, as a new save. Nothing in history is deleted.',
      });
      expect(await previewGoBack(git, third)).toEqual({
        ok    : false,
        reason: 'The project is already here.',
      });
      await write(dir, 'b.txt', 'edited\n');
      expect(await previewGoBack(git, first)).toEqual({ ok: false, reason: DIRTY_TREE });
    } finally {
      await cleanup();
    }
  });
});

describe('previewCheckpoint and checkpointNamed', () => {
  it('slugs the name, refuses a taken slug, and finds a checkpoint by slug or name', async () => {
    const { git, second, third, cleanup } = await seeded();
    try {
      expect(await previewCheckpoint(git, '  ', third)).toEqual({
        ok    : false,
        reason: 'A checkpoint needs a name.',
      });
      const fresh = await previewCheckpoint(git, 'Before the rain pass', second);
      expect(fresh).toMatchObject({ ok: true, slug: 'before-the-rain-pass' });
      await git.tag('before-the-rain-pass', second, 'Before the rain pass\n\nA note.');
      expect(await previewCheckpoint(git, 'before the RAIN pass', third)).toEqual({
        ok    : false,
        reason:
          'A checkpoint named “Before the rain pass” already exists; drop it or choose another name.',
      });
      expect(await previewCheckpoint(git, 'Before the rain pass', second)).toMatchObject({
        ok    : false,
        reason: expect.stringContaining('on this save'),
      });
      const checkpoints = await git.checkpoints();
      expect(checkpointNamed(checkpoints, 'before-the-rain-pass')?.sha).toBe(second);
      expect(checkpointNamed(checkpoints, 'Before the rain pass')?.note).toBe('A note.');
      expect(checkpointNamed(checkpoints, 'before the rain pass')?.sha).toBe(second);
      expect(checkpointNamed(checkpoints, 'other')).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
