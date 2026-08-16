import { coerceProps, prop } from '../props.js';

const specs = {
  name: prop.string('the name'),
  count: prop.number('how many', { default: 1, min: 0, max: 10 }),
  mock: prop.boolean('dry run', { default: false }),
  mode: prop.oneOf(['plan', 'execute'] as const, 'agent mode'),
  paths: prop.stringList('files', { default: [] }),
};

function coerce(raw: Record<string, unknown>) {
  return coerceProps(specs, raw);
}

describe('coerceProps', () => {
  it('applies defaults for omitted optional props', () => {
    expect(coerce({ name: 'a', mode: 'plan' })).toEqual({
      ok: true,
      value: { name: 'a', mode: 'plan', count: 1, mock: false, paths: [] },
    });
  });

  it('coerces the loose values DSL and CDP callers send', () => {
    const result = coerce({ name: 'a', mode: 'plan', count: '7', mock: 'true', paths: 'one' });
    expect(result).toMatchObject({ ok: true, value: { count: 7, mock: true, paths: ['one'] } });
  });

  it('reports every missing required prop at once', () => {
    const result = coerce({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors).toEqual([
      'missing required property "name"',
      'missing required property "mode"',
    ]);
  });

  it('rejects unknown properties', () => {
    const result = coerce({ name: 'a', mode: 'plan', nope: 1 });
    expect(result).toMatchObject({ ok: false, errors: ['unknown property "nope"'] });
  });

  it('rejects a value outside an enum', () => {
    const result = coerce({ name: 'a', mode: 'sideways' });
    expect(result).toMatchObject({
      ok: false,
      errors: ['property "mode" must be one of plan | execute'],
    });
  });

  it('enforces numeric bounds', () => {
    expect(coerce({ name: 'a', mode: 'plan', count: 99 })).toMatchObject({
      ok: false,
      errors: ['property "count" must be <= 10'],
    });
  });

  it('rejects an uncoercible value', () => {
    expect(coerce({ name: 'a', mode: 'plan', count: 'lots' })).toMatchObject({ ok: false });
  });
});

describe('prop builders', () => {
  it('marks a prop required exactly when it has no default', () => {
    expect(prop.string('x').required).toBe(true);
    expect(prop.string('x', { default: 'y' })).toMatchObject({ required: false, default: 'y' });
    // `false` is a real default, not an absent one.
    expect(prop.boolean('x', { default: false })).toMatchObject({
      required: false,
      default: false,
    });
  });

  it('coerces a directory exactly as a string, and declares itself one', () => {
    const dirSpecs = { path: prop.directory('where') };
    expect(prop.directory('where').kind).toBe('directory');
    expect(coerceProps(dirSpecs, { path: 'C:/dev/x' })).toEqual({
      ok: true,
      value: { path: 'C:/dev/x' },
    });
    expect(coerceProps(dirSpecs, { path: 7 })).toEqual({ ok: true, value: { path: '7' } });
  });

  it('records enum values and numeric bounds', () => {
    expect(prop.oneOf(['a', 'b'] as const, 'x').values).toEqual(['a', 'b']);
    expect(prop.number('x', { min: 1, max: 2 })).toMatchObject({ min: 1, max: 2 });
  });
});
