import { describeToolParams, jsonSchemaOf } from '../../index.js';
import { tool } from './testkit.js';

describe('registry metadata', () => {
  it('marks mutating tools and confirmation-gated tools', () => {
    expect(tool('read_file').mutating).toBe(false);
    expect(tool('edit_character').mutating).toBe(true);
    expect(tool('git_revert').confirm).toBe(true);
    expect(tool('git_restore').confirm).toBe(true);
  });

  it('describes tool arg names and intent so the model need not guess them', () => {
    const sig = describeToolParams(tool('edit_character').args);
    // The prose body field must be named and explained — the gap that caused edit churn.
    expect(sig).toContain('description?: string (full prose body');
    expect(sig).toContain('id: string');
    expect(sig).toContain('palette?: string[]');
    // Approval is not a field: a look is approved by accepting a portrait, never by a word here
    expect(sig).not.toContain('status');
    // Enums render their literal options.
    expect(describeToolParams(tool('set_art_notes').args)).toContain(
      'mode?: "append"|"replace"|"clear"',
    );
  });

  it('names the fields inside a nested shape rather than flattening it to object', () => {
    const sig = describeToolParams(tool('write_storyboard').args);
    // `shots[].subjects[]` is the deepest nesting in the registry, and the one the model spent
    // four refused calls guessing at.
    expect(sig).toContain('characterId: string');
    expect(sig).toContain('pose?: string');
    expect(sig).toContain('expression?: string');
    expect(sig).not.toContain('shots: object[]');
    // A record used to render as `any`, which named neither its keys nor its values.
    expect(describeToolParams(tool('edit_character').args)).toContain('record<string, ');
  });

  it('converts tool args to JSON Schema without letting the vendor refuse an unknown key', () => {
    const schema = jsonSchemaOf(tool('write_storyboard').args)!;
    const shots = (schema.properties as Record<string, Record<string, unknown>>).shots!;
    const shot = shots.items as Record<string, unknown>;
    expect(shot.type).toBe('object');
    expect(shot.required).toContain('location');
    const subject = (
      (shot.properties as Record<string, Record<string, unknown>>).subjects!.items as Record<
        string,
        unknown
      >
    ).properties as Record<string, unknown>;
    expect(Object.keys(subject)).toEqual(['characterId', 'pose', 'expression']);
    // `additionalProperties: false` would make a stray key a request error rather than an
    // observation the model can read and correct.
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":false');
  });
});
