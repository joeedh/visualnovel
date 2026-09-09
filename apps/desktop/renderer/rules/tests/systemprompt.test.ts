import { joinSections } from '@vn/authoring';
import {
  controls,
  copyAction,
  joined,
  reloadAction,
  roughTokens,
  scaleOf,
} from '../systemprompt.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { SystemSectionView } from '../../../src/shared/ipc';

const SECTIONS: SystemSectionView[] = [
  { name: 'BUILT-IN', text: 'one\ntwo' },
  { name: 'PROJECT CONTEXT (AICONTEXT.md)', text: 'three' },
];

describe('joined', () => {
  // The viewer claims to show what the agent is sent. The renderer cannot import the node-side
  // joiner, so the separator is written twice and this test keeps the two spellings equal
  it('joins exactly the way the agent does', () => {
    expect(joined(SECTIONS)).toBe(joinSections([...SECTIONS]));
  });

  it('is the empty string for no sections at all', () => {
    expect(joined([])).toBe('');
  });
});

describe('scaleOf', () => {
  it('counts the join rather than the parts — the separators are prompt too', () => {
    const text = joined(SECTIONS);
    expect(scaleOf(SECTIONS, 'claude-opus-5')).toContain(`${text.length} chars`);
    expect(scaleOf(SECTIONS, 'claude-opus-5')).toContain('2 sections');
    expect(scaleOf(SECTIONS, 'claude-opus-5')).toContain('4 lines');
    expect(scaleOf(SECTIONS, 'claude-opus-5')).toContain('claude-opus-5');
  });

  it('says one section without an s, and leaves an unbound model unnamed', () => {
    const one = scaleOf([{ name: 'BUILT-IN', text: 'x' }], '');
    expect(one).toContain('1 section ·');
    expect(one.endsWith('tokens')).toBe(true);
  });

  it('calls an empty prompt zero lines rather than one', () => {
    expect(scaleOf([], '')).toContain('0 lines');
  });
});

describe('roughTokens', () => {
  it('is characters over four, and says so by being called rough', () => {
    expect(roughTokens('12345678')).toBe(2);
  });
});

describe('controls', () => {
  it('offers Copy only once a prompt has been read, and reload always', () => {
    expect(copyAction(3)).toEqual({
      ok      : true,
      id      : 'app.copy',
      props   : { what: 'the system prompt' },
      label   : 'Copy',
      tooltip:
        'Put the whole prompt — every section, joined the way the agent gets it — on the clipboard',
      supplies: ['text'],
    });
    expect(copyAction(0)).toMatchObject({
      ok     : false,
      refusal: { reason: 'No prompt — open a project first.' },
    });
    expect(reloadAction()).toMatchObject({ props: { what: 'reload' }, on: 'reload', label: '⟳' });
    const listed = controls({ sections: 3 });
    expect(listed.map(keyOf)).toEqual(['cmd:app.copy', 'fx:pane.view#reload']);
    expect(duplicateKeys(listed)).toEqual([]);
  });
});
