import { saveOffer } from '../docbuffer.js';

describe('saveOffer', () => {
  it('writes the open file, with the text and hash supplied by the buffer', () => {
    expect(saveOffer('wiki/lore.md', true)).toEqual({
      ok      : true,
      id      : 'doc.write',
      props   : { path: 'wiki/lore.md' },
      label   : 'Save',
      tooltip : 'Write this file back to disk, and commit it',
      supplies: ['text', 'seenHash'],
    });
  });

  it('refuses with no file open, and with nothing changed', () => {
    expect(saveOffer('', true)).toMatchObject({
      ok     : false,
      id     : 'doc.write',
      refusal: { reason: 'No document is open.' },
    });
    expect(saveOffer('wiki/lore.md', false)).toMatchObject({
      ok     : false,
      id     : 'doc.write',
      refusal: { reason: 'Nothing to save' },
    });
  });

  // A closed buffer is never dirty, but if it were, the refusal would still name the missing file
  it('names the missing file before the unchanged text', () => {
    expect(saveOffer('', false)).toMatchObject({ refusal: { reason: 'No document is open.' } });
  });
});
