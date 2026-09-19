import { FORMS, selectForm } from '../docforms.js';

describe('the sheet forms', () => {
  it.each(['character', 'location'] as const)('adapt the %s schema whole', (kind) => {
    const { schema, presentation } = FORMS[kind];
    expect(schema.diagnostics).toEqual([]);
    expect(schema.root.kind).toBe('object');
    if (schema.root.kind !== 'object') return;
    const fields = Object.keys(schema.root.fields);
    // Every field has a place in the order and a label and help sentence to show
    expect([...(presentation.order ?? [])].sort()).toEqual([...fields].sort());
    const missing = fields.filter((name) => {
      const meta = presentation.fields?.[name];
      return !meta?.label || !meta.help;
    });
    expect(missing).toEqual([]);
    // A described field the schema lacks would be a typo FormControl never shows
    for (const name of Object.keys(presentation.fields ?? {})) expect(fields).toContain(name);
  });
});

describe('selectForm', () => {
  it('declines a note, so path.ux keeps the raw block', () => {
    expect(selectForm(undefined, {})).toBeUndefined();
    expect(selectForm(undefined, { title: 'Lore' })).toBeUndefined();
    expect(selectForm(undefined, 'not an object')).toBeUndefined();
  });

  it('picks the one form per kind, by identity, from the location or the tag', () => {
    expect(selectForm('character', {})).toBe(FORMS.character);
    expect(selectForm(undefined, { type: 'location' })).toBe(FORMS.location);
    expect(selectForm('location', { type: 'location' })).toBe(FORMS.location);
  });

  it('throws the conflict sentence, which reaches the footer through onDiagnostic', () => {
    expect(() => selectForm('character', { type: 'location' })).toThrow(
      'This document is a character by its location but declares type: location; move the file or fix the tag',
    );
  });
});
