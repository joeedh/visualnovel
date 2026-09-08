import { controls, createAction, renameAction } from '../documents.js';
import { duplicateKeys, keyOf } from '../anchors.js';

describe('createAction', () => {
  it('opens the new-document row, with the kind and the name typed after the click', () => {
    expect(createAction()).toEqual({
      ok      : true,
      id      : 'doc.create',
      props   : {},
      label   : 'New…',
      tooltip : 'Add a character, location, page or skill to this project',
      supplies: ['kind', 'name'],
    });
  });
});

describe('renameAction', () => {
  it('renames the one document, with the box supplying the name', () => {
    expect(renameAction({ path: 'characters/aiko/character.md', name: 'Aiko' })).toEqual({
      ok      : true,
      id      : 'doc.rename',
      props   : { path: 'characters/aiko/character.md' },
      label   : 'Aiko',
      tooltip : 'Type the new name — Enter renames the document, Escape leaves it as it was',
      supplies: ['name'],
    });
  });
});

describe('controls', () => {
  it('lists the create button, and the rename box only while one is open', () => {
    expect(controls({}).map(keyOf)).toEqual(['cmd:doc.create']);
    const renaming = { path: 'wiki/lore.md', name: 'Lore' };
    const listed = controls({ renaming });
    expect(new Set(listed.map(keyOf))).toEqual(
      new Set([createAction(), renameAction(renaming)].map(keyOf)),
    );
    expect(duplicateKeys(listed)).toEqual([]);
  });
});
