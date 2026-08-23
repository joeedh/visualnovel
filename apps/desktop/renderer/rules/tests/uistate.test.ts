import { prunedIds, repairedAsset, type IndexedIds, type SelectedIds } from '../uistate.js';

describe('repairedAsset', () => {
  it('keeps a hash the manifest still answers for', () => {
    expect(repairedAsset('a1', { ok: true })).toBe('a1');
  });

  it('follows a superseded take to the asset filling its slot now', () => {
    expect(repairedAsset('a1', { ok: true, newerTake: 'b2' })).toBe('b2');
  });

  it('clears a hash the project no longer holds', () => {
    expect(repairedAsset('a1', { ok: false })).toBe('');
  });
});

describe('prunedIds', () => {
  const index: IndexedIds = {
    scenes: [{ id: 'arrival' }],
    characters: [{ id: 'aiko' }],
  };
  const selected = (over: Partial<SelectedIds> = {}): SelectedIds => ({
    sceneId: 'arrival',
    shotId: 's2',
    characterId: 'aiko',
    ...over,
  });

  it('clears nothing while the index lists everything', () => {
    expect(prunedIds(selected(), index)).toEqual({});
  });

  it('clears a scene the index does not list, and the shot under it', () => {
    expect(prunedIds(selected({ sceneId: 'deleted' }), index)).toEqual({ sceneId: '', shotId: '' });
  });

  it('leaves a shot alone while its scene is still there', () => {
    expect(prunedIds(selected({ shotId: 'gone' }), index)).toEqual({});
  });

  it('clears a character the index does not list', () => {
    expect(prunedIds(selected({ characterId: 'renamed' }), index)).toEqual({ characterId: '' });
  });

  it('clears nothing for an empty selection, whatever the index holds', () => {
    const empty: SelectedIds = { sceneId: '', shotId: '', characterId: '' };
    expect(prunedIds(empty, { scenes: [], characters: [] })).toEqual({});
  });
});
