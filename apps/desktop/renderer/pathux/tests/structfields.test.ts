import * as ns from 'nstructjs';
import { closeStruct } from '../structfields.js';

describe('closeStruct', () => {
  it('closes an open head, whether or not it ended in a newline', () => {
    expect(closeStruct('vn.Editor{\n  flag : int;\n')).toBe('vn.Editor{\n  flag : int;\n}');
    expect(closeStruct('vn.Editor{')).toBe('vn.Editor{\n}');
  });

  it('declares each field on its own indented line, inside the brace', () => {
    expect(closeStruct('vn.Editor{\n  flag : int;\n', ['mode : string', 'depth : int'])).toBe(
      'vn.Editor{\n  flag : int;\n  mode : string;\n  depth : int;\n}',
    );
  });

  // The caller writes nstructjs's own syntax, and its own examples end in a semicolon — so both
  // spellings have to mean the same field rather than one of them producing `mode : string;;`.
  it('is indifferent to a trailing semicolon or surrounding space', () => {
    expect(closeStruct('x{\n', ['  mode : string;  ', '', '  '])).toBe('x{\n  mode : string;\n}');
  });
});

/**
 * The reason the splice exists: a per-pane field has to survive being written into a saved
 * layout and read back out. Against the real nstructjs, not a golden string — the syntax it
 * accepts is the thing under test.
 */
describe('a spliced field, through nstructjs', () => {
  class Pane {
    static STRUCT: string;
    flag = 0;
    mode = 'documents';

    loadSTRUCT(reader: (obj: Pane) => void) {
      reader(this);
    }
  }
  Pane.STRUCT = closeStruct('tests.Pane{\n  flag : int;\n', ['mode : string']);
  ns.register(Pane);

  it('comes back with the field it was saved with', () => {
    const pane = new Pane();
    pane.flag = 3;
    pane.mode = 'files';

    const back = ns.readJSON<Pane>(ns.writeJSON(pane), Pane);
    expect(back.mode).toBe('files');
    expect(back.flag).toBe(3);
    expect(back).toBeInstanceOf(Pane);
  });
});
