import { parseFountain, parseFrontMatter } from '@vn/parse';
import {
  applyCharacterEdit,
  applyLocationEdit,
  characterFromDoc,
  characterToDoc,
  docToMarkdown,
  locationFromDoc,
  locationToDoc,
  sceneToFountain,
  splitScenes,
} from '../index.js';

const charDoc = parseFrontMatter(
  `---\nid: ren\nname: Ren\nstatus: draft\ndefault_outfit: uniform\ntraits:\n  - guarded\npalette:\n  - '#112233'\nreference_images: []\n---\n\nRen is a guarded transfer student.\n`,
);

const locDoc = parseFrontMatter(
  `---\nid: rooftop\nname: Rooftop\nmood: contemplative\nlighting: golden hour\npalette:\n  - '#ffaa00'\nvariants:\n  - day\n  - sunset\n---\n\nA wind-swept school rooftop overlooking the city.\n`,
);

describe('character round-trip', () => {
  it('fromDoc(toDoc(x)) ≡ x', () => {
    const a = characterFromDoc(charDoc);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = characterFromDoc(characterToDoc(a.value));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.value).toEqual(a.value);
  });

  it('serializes to valid markdown that re-parses', () => {
    const a = characterFromDoc(charDoc);
    if (!a.ok) throw new Error('setup');
    const md = docToMarkdown(characterToDoc(a.value));
    expect(md).toContain('id: ren');
    const reparsed = characterFromDoc(parseFrontMatter(md));
    expect(reparsed.ok).toBe(true);
  });
});

describe('location round-trip', () => {
  it('fromDoc(toDoc(x)) ≡ x', () => {
    const a = locationFromDoc(locDoc);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = locationFromDoc(locationToDoc(a.value));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.value).toEqual(a.value);
  });
});

describe('applyCharacterEdit', () => {
  it('patches one field, preserves the rest and the body', () => {
    const res = applyCharacterEdit(charDoc, { status: 'approved' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.value.status).toBe('approved');
    expect(res.value.value.name).toBe('Ren');
    expect(res.value.doc.body.trim()).toBe('Ren is a guarded transfer student.');
  });

  it('rewrites the description body when provided', () => {
    const res = applyCharacterEdit(charDoc, { description: 'Ren has thawed.' });
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.value.description).toBe('Ren has thawed.');
  });

  it('preserves unrelated hand-authored front-matter keys', () => {
    const doc = parseFrontMatter(`---\nid: ren\nname: Ren\nvoice: terse\n---\n\nbody\n`);
    const res = applyCharacterEdit(doc, { status: 'approved' });
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.doc.data['voice']).toBe('terse');
  });

  it('rejects an invalid edit with a diagnostic', () => {
    const res = applyCharacterEdit(charDoc, { palette: ['not-a-color'] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostic.code).toBe('character_frontmatter');
  });
});

describe('applyLocationEdit', () => {
  it('adds a variant', () => {
    const res = applyLocationEdit(locDoc, { variants: ['day', 'sunset', 'night'] });
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.value.variants.map((v) => v.id)).toEqual(['day', 'sunset', 'night']);
  });
});

describe('sceneToFountain', () => {
  it('emits Fountain whose graph fields survive a re-parse', () => {
    const fountain = sceneToFountain({
      id: 's12',
      location: 'rooftop',
      characters: [],
      synopsis: 'Ren hesitates at the door.',
      lines: [],
      choices: [
        { label: 'Knock', goto: 's13' },
        { label: 'Leave', goto: 's14' },
      ],
      next: undefined,
      shots: [],
    });
    const { scenes } = splitScenes(parseFountain(fountain));
    expect(scenes).toHaveLength(1);
    const s = scenes[0]!;
    expect(s.id).toBe('s12');
    expect(s.location).toBe('rooftop');
    expect(s.synopsis).toBe('Ren hesitates at the door.');
    expect(s.choices).toEqual([
      { label: 'Knock', goto: 's13' },
      { label: 'Leave', goto: 's14' },
    ]);
  });

  it('emits a linear next marker', () => {
    const fountain = sceneToFountain({
      id: 'a',
      location: 'hall',
      characters: [],
      lines: [],
      choices: [],
      next: 'b',
      shots: [],
    });
    const { scenes } = splitScenes(parseFountain(fountain));
    expect(scenes[0]!.next).toBe('b');
  });
});
