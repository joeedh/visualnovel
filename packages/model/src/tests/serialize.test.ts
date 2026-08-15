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

  it('drops the retired reference_images key rather than carrying it forward', () => {
    const a = characterFromDoc(charDoc);
    if (!a.ok) throw new Error('setup');
    expect(charDoc.data['reference_images']).toEqual([]);
    expect(characterToDoc(a.value).data['reference_images']).toBeUndefined();
  });

  it('gives a sheet with no wardrobe exactly one outfit, undescribed', () => {
    const a = characterFromDoc(charDoc);
    if (!a.ok) throw new Error('setup');
    expect(a.value.outfits).toEqual([{ id: 'uniform', characterId: 'ren', description: '' }]);
    // And writing it back does not grow an `outfits:` key in every existing character sheet.
    expect(characterToDoc(a.value).data['outfits']).toBeUndefined();
  });

  it('keeps an authored wardrobe in written order, and round-trips it', () => {
    const doc = parseFrontMatter(
      `---\nid: ren\nname: Ren\ndefault_outfit: uniform\noutfits:\n  uniform: grey blazer\n  track: club tracksuit\n---\n\nRen.\n`,
    );
    const a = characterFromDoc(doc);
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.outfits.map((o) => o.id)).toEqual(['uniform', 'track']);
    expect(a.value.outfits[1]?.description).toBe('club tracksuit');
    const b = characterFromDoc(characterToDoc(a.value));
    if (!b.ok) throw new Error('expected ok');
    expect(b.value).toEqual(a.value);
  });

  it('synthesizes the default outfit when the wardrobe omits it, first', () => {
    const doc = parseFrontMatter(
      `---\nid: ren\nname: Ren\ndefault_outfit: uniform\noutfits:\n  track: club tracksuit\n---\n\nRen.\n`,
    );
    const a = characterFromDoc(doc);
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.outfits.map((o) => o.id)).toEqual(['uniform', 'track']);
    expect(a.value.outfits[0]?.description).toBe('');
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

describe('art notes', () => {
  const richChar = parseFrontMatter(
    `---\nid: ren\nname: Ren\ndefault_outfit: uniform\nart_notes: ink-wash linework\noutfits:\n  uniform: grey blazer\n  gala:\n    description: floor-length navy dress\n    art_notes: satin sheen, rim light\n---\n\nRen.\n`,
  );
  const richLoc = parseFrontMatter(
    `---\nid: cafe\nname: Café Mori\nart_notes: heavy formwork\nvariants:\n  - day\n  - id: night\n    description: after close, chairs up\n    art_notes: sodium streetlight\n---\n\nA corner café.\n`,
  );

  it('reads both authored forms of an outfit, and round-trips each as it was written', () => {
    const a = characterFromDoc(richChar);
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.artNotes).toBe('ink-wash linework');
    expect(a.value.outfits).toEqual([
      { id: 'uniform', characterId: 'ren', description: 'grey blazer' },
      {
        id: 'gala',
        characterId: 'ren',
        description: 'floor-length navy dress',
        artNotes: 'satin sheen, rim light',
      },
    ]);
    // The short form stays short: only the outfit carrying direction grows an object.
    const outfits = characterToDoc(a.value).data['outfits'] as Record<string, unknown>;
    expect(outfits['uniform']).toBe('grey blazer');
    expect(outfits['gala']).toEqual({
      description: 'floor-length navy dress',
      art_notes: 'satin sheen, rim light',
    });
    const b = characterFromDoc(characterToDoc(a.value));
    if (!b.ok) throw new Error('expected ok');
    expect(b.value).toEqual(a.value);
  });

  it('reads both authored forms of a variant, and keeps a bare one bare', () => {
    const a = locationFromDoc(richLoc);
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.artNotes).toBe('heavy formwork');
    expect(a.value.variants).toEqual([
      { id: 'day', description: '' },
      { id: 'night', description: 'after close, chairs up', artNotes: 'sodium streetlight' },
    ]);
    expect(locationToDoc(a.value).data['variants']).toEqual([
      'day',
      {
        id: 'night',
        description: 'after close, chairs up',
        art_notes: 'sodium streetlight',
      },
    ]);
    const b = locationFromDoc(locationToDoc(a.value));
    if (!b.ok) throw new Error('expected ok');
    expect(b.value).toEqual(a.value);
  });

  it('never grows an art_notes key on a sheet that authored none', () => {
    const a = characterFromDoc(charDoc);
    const l = locationFromDoc(locDoc);
    if (!a.ok || !l.ok) throw new Error('setup');
    expect(characterToDoc(a.value).data['art_notes']).toBeUndefined();
    expect(locationToDoc(l.value).data['art_notes']).toBeUndefined();
    expect(locationToDoc(l.value).data['variants']).toEqual(['day', 'sunset']);
  });

  it('sets art notes through an edit, and an empty string removes the key', () => {
    const set = applyCharacterEdit(charDoc, { artNotes: 'ink-wash linework' });
    if (!set.ok) throw new Error('expected ok');
    expect(set.value.value.artNotes).toBe('ink-wash linework');
    const cleared = applyCharacterEdit(set.value.doc, { artNotes: '' });
    if (!cleared.ok) throw new Error('expected ok');
    expect(cleared.value.doc.data['art_notes']).toBeUndefined();
    expect(cleared.value.value.artNotes).toBeUndefined();
  });

  it('sets a variant-level note through an edit', () => {
    const res = applyLocationEdit(locDoc, {
      variants: ['day', { id: 'sunset', art_notes: 'long shadows' }],
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.value.variants[1]).toEqual({
      id: 'sunset',
      description: '',
      artNotes: 'long shadows',
    });
  });
});

describe('prompt overrides', () => {
  const overridden = parseFrontMatter(
    `---\nid: ren\nname: Ren\ndefault_outfit: uniform\nprompt_override:\n  mode: chunks\n  mute:\n    - palette\n  replace:\n    subject: A portrait of Ren, three-quarter.\noutfits:\n  uniform: grey blazer\n  gala:\n    description: floor-length navy dress\n    prompt_override:\n      mode: custom\n      custom: Ren in a navy gown.\n---\n\nRen.\n`,
  );
  const overriddenLoc = parseFrontMatter(
    `---\nid: cafe\nname: Café Mori\nvariants:\n  - day\n  - id: night\n    prompt_override:\n      mode: chunks\n      append:\n        mood:\n          text: Rain on the glass.\n          of: abc123\n---\n\nA corner café.\n`,
  );

  it('reads a sheet-level override as the portrait’s, and round-trips it', () => {
    const a = characterFromDoc(overridden);
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.promptOverride).toEqual({
      mode: 'chunks',
      mute: ['palette'],
      replace: { subject: { text: 'A portrait of Ren, three-quarter.' } },
    });
    // An edit with no `of` is written back as the bare string it was authored as.
    expect(characterToDoc(a.value).data['prompt_override']).toEqual({
      mode: 'chunks',
      mute: ['palette'],
      replace: { subject: 'A portrait of Ren, three-quarter.' },
    });
    const b = characterFromDoc(characterToDoc(a.value));
    if (!b.ok) throw new Error('expected ok');
    expect(b.value).toEqual(a.value);
  });

  it('escalates an outfit to the long form to carry an override', () => {
    const a = characterFromDoc(overridden);
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.outfits[1]?.promptOverride).toEqual({
      mode: 'custom',
      custom: 'Ren in a navy gown.',
    });
    const outfits = characterToDoc(a.value).data['outfits'] as Record<string, unknown>;
    expect(outfits['uniform']).toBe('grey blazer');
    expect(outfits['gala']).toEqual({
      description: 'floor-length navy dress',
      prompt_override: { mode: 'custom', custom: 'Ren in a navy gown.' },
    });
  });

  it('escalates a variant, keeping an edit’s `of`', () => {
    const a = locationFromDoc(overriddenLoc);
    if (!a.ok) throw new Error('expected ok');
    expect(a.value.variants[1]?.promptOverride?.append).toEqual({
      mood: { text: 'Rain on the glass.', of: 'abc123' },
    });
    expect(locationToDoc(a.value).data['variants']).toEqual([
      'day',
      {
        id: 'night',
        prompt_override: {
          mode: 'chunks',
          append: { mood: { text: 'Rain on the glass.', of: 'abc123' } },
        },
      },
    ]);
    const b = locationFromDoc(locationToDoc(a.value));
    if (!b.ok) throw new Error('expected ok');
    expect(b.value).toEqual(a.value);
  });

  it('never grows a prompt_override key on a sheet that authored none', () => {
    const a = characterFromDoc(charDoc);
    const l = locationFromDoc(locDoc);
    if (!a.ok || !l.ok) throw new Error('setup');
    expect(characterToDoc(a.value).data['prompt_override']).toBeUndefined();
    expect(characterToDoc(a.value).data['outfits']).toBeUndefined();
    expect(locationToDoc(l.value).data['variants']).toEqual(['day', 'sunset']);
  });

  it('round-trips a chunk’s references, binding and all', () => {
    const withRefs = applyCharacterEdit(charDoc, {
      promptOverride: {
        mode: 'chunks',
        refs: {
          description: [
            { pin: 'aa11', ext: 'png', from: { kind: 'portrait', characterId: 'ren' } },
            { pin: 'bb22', ext: 'jpg', note: 'the coat, from a photo' },
          ],
        },
      },
    });
    if (!withRefs.ok) throw new Error('expected ok');
    // A reference list is the whole override here: refs alone must not read as "says nothing".
    expect(withRefs.value.doc.data['prompt_override']).toEqual({
      mode: 'chunks',
      refs: {
        description: [
          { pin: 'aa11', ext: 'png', from: { kind: 'portrait', characterId: 'ren' } },
          { pin: 'bb22', ext: 'jpg', note: 'the coat, from a photo' },
        ],
      },
    });
    expect(withRefs.value.value.promptOverride?.refs?.['description']).toHaveLength(2);
    const back = characterFromDoc(characterToDoc(withRefs.value.value));
    if (!back.ok) throw new Error('expected ok');
    expect(back.value).toEqual(withRefs.value.value);
  });

  it('drops a chunk key whose reference list emptied', () => {
    const emptied = applyCharacterEdit(charDoc, {
      promptOverride: { mode: 'chunks', refs: { description: [] } },
    });
    if (!emptied.ok) throw new Error('expected ok');
    expect(emptied.value.doc.data['prompt_override']).toBeUndefined();
  });

  it('sets one through an edit, and an override that says nothing removes the key', () => {
    const set = applyCharacterEdit(charDoc, {
      promptOverride: { mode: 'chunks', mute: ['palette'] },
    });
    if (!set.ok) throw new Error('expected ok');
    expect(set.value.value.promptOverride?.mute).toEqual(['palette']);
    // `mode` alone is not an override: all three modes fall back to the derived chunks.
    const cleared = applyCharacterEdit(set.value.doc, { promptOverride: { mode: 'chunks' } });
    if (!cleared.ok) throw new Error('expected ok');
    expect(cleared.value.doc.data['prompt_override']).toBeUndefined();
    expect(cleared.value.value.promptOverride).toBeUndefined();
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

  it('replaces the whole wardrobe map', () => {
    const res = applyCharacterEdit(charDoc, { outfits: { uniform: 'grey blazer', swim: 'navy' } });
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.value.outfits.map((o) => o.id)).toEqual(['uniform', 'swim']);
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
