import { DslError, formatCommand, parseCommand } from '../dsl.js';

describe('parseCommand', () => {
  it('parses the documented form', () => {
    expect(parseCommand("something.command(property1='bleh' property2=1)")).toEqual({
      id   : 'something.command',
      props: { property1: 'bleh', property2: 1 },
    });
  });

  it('accepts no arguments', () => {
    expect(parseCommand('pipeline.status()')).toEqual({ id: 'pipeline.status', props: {} });
  });

  it('treats commas and whitespace as interchangeable separators', () => {
    const spaced = parseCommand("gate.approve(characterId='aiko' hash='9e0a')");
    expect(parseCommand("gate.approve(characterId='aiko', hash='9e0a')")).toEqual(spaced);
    expect(parseCommand("gate.approve(\n  characterId='aiko',\n  hash='9e0a',\n)")).toEqual(spaced);
  });

  it('parses every value kind', () => {
    const { props } = parseCommand(
      'x.y(s="dq" b=true f=false n=-1.5 e=2e3 bare=execute list=[\'a\', "b"])',
    );
    expect(props).toEqual({
      s   : 'dq',
      b   : true,
      f   : false,
      n   : -1.5,
      e   : 2000,
      bare: 'execute',
      list: ['a', 'b'],
    });
  });

  it('handles escapes inside strings', () => {
    expect(parseCommand("x.y(s='it\\'s\\na \\\\ test')").props.s).toBe("it's\na \\ test");
  });

  it('supports deeper namespaces', () => {
    expect(parseCommand('a.b.c()').id).toBe('a.b.c');
  });

  it.each([
    ['bare', 'nonamespace()'],
    ['missing parens', 'gate.approve'],
    ['unterminated string', "gate.approve(id='aiko)"],
    ['unterminated array', 'gate.approve(ids=[a, b)'],
    ['missing value', 'gate.approve(id=)'],
    ['trailing input', 'gate.approve() extra'],
    ['duplicate property', "gate.approve(id='a' id='b')"],
  ])('rejects %s', (_label, text) => {
    expect(() => parseCommand(text)).toThrow(DslError);
  });

  it('reports a 1-based column on failure', () => {
    expect(() => parseCommand('gate.approve(id=)')).toThrow(/column 17/);
  });
});

describe('formatCommand', () => {
  it('round-trips through the parser', () => {
    const cases: Record<string, string | number | boolean | string[]>[] = [
      { property1: 'bleh', property2: 1 },
      {},
      { s: "it's\nquoted \\ odd", n: -0.5, b: false, list: ['a', 'b'] },
      // A string that looks like a number must survive as a string.
      { looksNumeric: '123', looksBoolean: 'true' },
    ];
    for (const props of cases) {
      const text = formatCommand('ns.cmd', props);
      expect(parseCommand(text)).toEqual({ id: 'ns.cmd', props });
    }
  });

  it('renders the documented shape', () => {
    expect(formatCommand('something.command', { property1: 'bleh', property2: 1 })).toBe(
      "something.command(property1='bleh' property2=1)",
    );
  });
});
