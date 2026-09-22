import { DIRTY_TREE, NO_UPSTREAM as GIT_NO_UPSTREAM } from '@vn/git';
import {
  blobUrl,
  kindOf,
  NO_UPSTREAM,
  parseGitUrl,
  readableConflict,
  UNSAVED_EDITS,
} from '../history.js';

describe('parseGitUrl', () => {
  it('reads back what blobUrl wrote', () => {
    expect(parseGitUrl(blobUrl('project', 'ab12', 'x.png'))).toEqual({
      role: 'project',
      ref : 'ab12',
      ext : 'png',
    });
  });

  it('reads a commit and a path, keeping the path’s slashes', () => {
    expect(parseGitUrl('vngit://wiki/deadbeef/places/the%20harbour.md')).toEqual({
      role: 'wiki',
      ref : 'deadbeef',
      path: 'places/the harbour.md',
      ext : 'md',
    });
  });

  it('refuses another scheme, an unknown role and an empty path', () => {
    expect(parseGitUrl('vnasset://project/ab12.png')).toBeNull();
    expect(parseGitUrl('vngit://elsewhere/ab12.png')).toBeNull();
    expect(parseGitUrl('vngit://project/')).toBeNull();
    expect(parseGitUrl('not a url')).toBeNull();
  });
});

describe('kindOf', () => {
  it.each([
    ['scenes/rooftop.md', 'scene'],
    ['scenes/rooftop.fountain', 'scene'],
    ['screenplay.fountain', 'scene'],
    ['screenplay/script.fountain', 'scene'],
    ['scenes/notes.txt', 'other'],
    ['characters/mara/mara.md', 'sheet'],
    ['locations/rooftop.md', 'sheet'],
    ['characters/mara/portrait.png', 'picture'],
    ['assets/objects/ab12.png', 'picture'],
    ['vngen/build/assets/cd34.webp', 'picture'],
    ['wiki/places/the-harbour.md', 'wiki'],
    ['.aiagent/skills/x/SKILL.md', 'wiki'],
    ['vngen/work/shots/rooftop.json', 'storyboard'],
    ['vngen/work/graphs/hero.json', 'storyboard'],
    ['project.yaml', 'project'],
    ['.vnstudio/layouts/mine.json', 'project'],
    ['wiki', 'project'],
    ['.gitmodules', 'project'],
    ['vngen/state/commands.jsonl', 'log'],
    ['vngen/state/threads/20260914-182452.jsonl', 'log'],
    ['assets/manifest.json', 'log'],
    ['characters/mara/notes.txt', 'other'],
    ['.gitignore', 'other'],
  ] as const)('%s is %s', (path, kind) => {
    expect(kindOf(path)).toBe(kind);
  });
});

describe('blobUrl', () => {
  it('carries the role as the host and the extension from the path', () => {
    expect(blobUrl('project', 'ab12', 'assets/objects/x.PNG')).toBe('vngit://project/ab12.png');
    expect(blobUrl('wiki', 'ab12', 'notes/README')).toBe('vngit://wiki/ab12.bin');
    expect(blobUrl('base', 'ab12', 'a.b/c')).toBe('vngit://base/ab12.bin');
  });
});

describe('readableConflict', () => {
  it.each([
    ['scenes/rooftop.fountain', true],
    ['characters/mara/mara.md', true],
    ['project.yaml', true],
    ['vngen/work/shots/rooftop.json', true],
    ['.vnstudio/layouts/writing.json', false],
    ['vngen/work/graphs/hero.json', false],
    ['vngen/work/graphs/lib/portrait.json', false],
    ['vngen/state/threads/20260914-182452.native.jsonl', false],
    ['vngen/state/threads/20260914-182452.jsonl', false],
    ['characters/mara/portrait.png', false],
  ] as const)('%s → %s', (path, readable) => {
    expect(readableConflict(path)).toBe(readable);
  });
});

/** The renderer cannot import `@vn/git`, so the two sentences it repeats are pinned to the source. */
describe('the sentences shared with @vn/git', () => {
  it('are the same words in both places', () => {
    expect(NO_UPSTREAM).toBe(GIT_NO_UPSTREAM);
    expect(UNSAVED_EDITS).toBe(DIRTY_TREE);
  });
});
