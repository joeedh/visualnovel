/**
 * The invocation DSL: `namespace.command(prop1='bleh' prop2=1)`.
 *
 * Hand-rolled tokenizer + recursive descent — small enough to keep pure and exhaustively
 * testable, and it lets errors carry a column so the palette can point at the offending
 * character. Argument separators are whitespace and/or commas, interchangeably.
 */
import type { PropValue } from './props.js';

export interface Invocation {
  id: string;
  props: Record<string, PropValue>;
}

export class DslError extends Error {
  constructor(
    message: string,
    readonly column: number,
  ) {
    super(`${message} (at column ${column + 1})`);
    this.name = 'DslError';
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_REST = /[A-Za-z0-9_-]/;

class Parser {
  private i = 0;

  constructor(private readonly src: string) {}

  parse(): Invocation {
    this.ws();
    const id = this.path();
    this.ws();
    this.expect('(');
    const props = this.args();
    this.expect(')');
    this.ws();
    if (this.i < this.src.length) this.fail(`unexpected trailing input`);
    return { id, props };
  }

  private fail(message: string): never {
    throw new DslError(message, this.i);
  }

  private peek(): string {
    return this.src[this.i] ?? '';
  }

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`expected "${ch}"`);
    this.i++;
  }

  private ident(): string {
    const start = this.i;
    if (!IDENT_START.test(this.peek())) this.fail('expected an identifier');
    this.i++;
    while (this.i < this.src.length && IDENT_REST.test(this.src[this.i]!)) this.i++;
    return this.src.slice(start, this.i);
  }

  /** `namespace.command` — at least two dot-separated segments. */
  private path(): string {
    const parts = [this.ident()];
    while (this.peek() === '.') {
      this.i++;
      parts.push(this.ident());
    }
    if (parts.length < 2) this.fail('command id needs a namespace, e.g. "gate.approve"');
    return parts.join('.');
  }

  /** Consume whitespace and at most one comma between items. */
  private separator(): void {
    this.ws();
    if (this.peek() === ',') {
      this.i++;
      this.ws();
    }
  }

  private args(): Record<string, PropValue> {
    const props: Record<string, PropValue> = {};
    this.ws();
    while (this.peek() !== ')' && this.i < this.src.length) {
      const name = this.ident();
      this.ws();
      this.expect('=');
      this.ws();
      if (name in props) this.fail(`duplicate property "${name}"`);
      props[name] = this.value();
      this.separator();
    }
    return props;
  }

  private value(): PropValue {
    const ch = this.peek();
    if (ch === "'" || ch === '"') return this.quoted(ch);
    if (ch === '[') return this.array();
    if (ch === '-' || /[0-9]/.test(ch)) return this.number();
    if (IDENT_START.test(ch)) {
      // Barewords are strings, so `agent.setMode(mode=execute)` reads naturally; `true` and
      // `false` are the two that mean themselves. `coerceProps` sorts out the rest.
      const word = this.ident();
      if (word === 'true') return true;
      if (word === 'false') return false;
      return word;
    }
    this.fail('expected a value');
  }

  private quoted(quote: string): string {
    this.i++;
    let out = '';
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === '\\') {
        const next = this.src[this.i + 1];
        if (next === undefined) this.fail('unterminated escape');
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        this.i += 2;
        continue;
      }
      if (ch === quote) {
        this.i++;
        return out;
      }
      out += ch;
      this.i++;
    }
    this.fail('unterminated string');
  }

  private number(): number {
    const start = this.i;
    if (this.peek() === '-') this.i++;
    while (this.i < this.src.length && /[0-9.eE+-]/.test(this.src[this.i]!)) this.i++;
    const text = this.src.slice(start, this.i);
    const n = Number(text);
    if (!Number.isFinite(n)) this.fail(`invalid number "${text}"`);
    return n;
  }

  /** Only string arrays are expressible — the one list kind commands take. */
  private array(): string[] {
    this.i++;
    const out: string[] = [];
    this.ws();
    while (this.peek() !== ']') {
      if (this.i >= this.src.length) this.fail('unterminated array');
      const v = this.value();
      out.push(typeof v === 'string' ? v : String(v));
      this.separator();
    }
    this.i++;
    return out;
  }
}

/** Parse one invocation. Throws `DslError` with a column on malformed input. */
export function parseCommand(text: string): Invocation {
  return new Parser(text).parse();
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

function literal(v: PropValue): string {
  if (Array.isArray(v)) return `[${v.map(quote).join(', ')}]`;
  if (typeof v === 'string') return quote(v);
  return String(v);
}

/** Render an invocation back to DSL. `parseCommand(formatCommand(x)) ≡ x`. */
export function formatCommand(id: string, props: Record<string, PropValue>): string {
  const args = Object.entries(props)
    .map(([k, v]) => `${k}=${literal(v)}`)
    .join(' ');
  return `${id}(${args})`;
}
