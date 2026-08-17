/**
 * Declarative property specs for commands. Deliberately not zod: a command's props have to
 * serialize into the build-time JSON catalog, coerce loose values arriving from the DSL and
 * CDP, and (later) drive a properties panel. One introspectable spec serves all three; a
 * zod schema serves none of them without a second hand-rolled walker.
 */

/**
 * `directory` is a string everywhere that matters — it coerces, serializes and schematizes as
 * one. It is its own kind so a form knows the OS can fill it in, rather than inferring that
 * from a property happening to be spelled `path`.
 *
 * `secret` is the same trick for the opposite reason: a credential, which the history must
 * record as `<secret>` rather than as itself (`digest.ts`).
 */
export type PropKind =
  | 'string'
  | 'directory'
  | 'secret'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'string[]';

/** Every value a command property can hold. Matches what the DSL can express. */
export type PropValue = string | number | boolean | string[];

/** One declared property. `Req` is carried in the type so `PropsOf` can split required/optional. */
export interface Prop<T extends PropValue = PropValue, Req extends boolean = boolean> {
  kind: PropKind;
  description: string;
  required: Req;
  default?: T;
  /** Permitted values; `kind: 'enum'` only. */
  values?: readonly string[];
  /** Inclusive bounds; `kind: 'number'` only. */
  min?: number;
  max?: number;
  /**
   * This property carries bulk content — a whole document — so the history records a digest of
   * it instead of the value (`digest.ts`). The command still receives the real thing.
   */
  digest?: boolean;
}

export type PropSpecMap = Record<string, Prop<PropValue, boolean>>;

type ValueOf<P> = P extends Prop<infer T, boolean> ? T : never;

/**
 * The runtime props object a command's `run` receives. Every key is present: `coerceProps`
 * has already filled in the defaults, so optionality belongs to the *raw* input, not here.
 * `Req` still matters — the catalog reads it off the spec to build the JSON-Schema
 * `required` list — but no consumer needs it at the type level.
 */
export type PropsOf<M extends PropSpecMap> = { [K in keyof M]: ValueOf<M[K]> };

interface Opts<T extends PropValue> {
  min?: number;
  max?: number;
  default?: T;
  digest?: boolean;
}

/**
 * Builders for the prop kinds. Passing a `default` makes the property optional; the overloads
 * narrow `Prop`'s `Req` parameter so `PropsOf` sees the difference. Declared as an interface
 * because object literals can't carry overload signatures.
 */
interface PropBuilders {
  string(description: string): Prop<string, true>;
  string(description: string, opts: { digest: true }): Prop<string, true>;
  string(description: string, opts: Opts<string> & { default: string }): Prop<string, false>;

  directory(description: string): Prop<string, true>;
  directory(description: string, opts: Opts<string> & { default: string }): Prop<string, false>;

  secret(description: string): Prop<string, true>;

  number(description: string, opts?: Omit<Opts<number>, 'default'>): Prop<number, true>;
  number(description: string, opts: Opts<number> & { default: number }): Prop<number, false>;

  boolean(description: string): Prop<boolean, true>;
  boolean(description: string, opts: Opts<boolean> & { default: boolean }): Prop<boolean, false>;

  oneOf<const V extends readonly string[]>(values: V, description: string): Prop<V[number], true>;
  oneOf<const V extends readonly string[]>(
    values: V,
    description: string,
    opts: { default: V[number] },
  ): Prop<V[number], false>;

  stringList(description: string): Prop<string[], true>;
  stringList(description: string, opts: { default: string[] }): Prop<string[], false>;
}

function make(
  kind: PropKind,
  description: string,
  opts: Opts<PropValue> | undefined,
  values?: readonly string[],
): Prop<PropValue, boolean> {
  const required = opts?.default === undefined;
  const spec: Prop<PropValue, boolean> = { kind, description, required };
  if (!required) spec.default = opts?.default;
  if (values) spec.values = values;
  if (opts?.min !== undefined) spec.min = opts.min;
  if (opts?.max !== undefined) spec.max = opts.max;
  if (opts?.digest) spec.digest = true;
  return spec;
}

export const prop: PropBuilders = {
  string: (description: string, opts?: Opts<string>) => make('string', description, opts),
  directory: (description: string, opts?: Opts<string>) => make('directory', description, opts),
  secret: (description: string) => make('secret', description, undefined),
  number: (description: string, opts?: Opts<number>) => make('number', description, opts),
  boolean: (description: string, opts?: Opts<boolean>) => make('boolean', description, opts),
  oneOf: (values: readonly string[], description: string, opts?: Opts<string>) =>
    make('enum', description, opts, values),
  stringList: (description: string, opts?: Opts<string[]>) => make('string[]', description, opts),
} as PropBuilders;

export type CoerceResult =
  | { ok: true; value: Record<string, PropValue> }
  | { ok: false; errors: string[] };

/** Coerce one loose value to `kind`; `undefined` means it can't be. */
function coerceOne(kind: PropKind, raw: unknown): PropValue | undefined {
  switch (kind) {
    case 'string':
    case 'directory':
    case 'secret':
    case 'enum':
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      return undefined;
    case 'number': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return undefined;
    case 'string[]':
      if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return raw as string[];
      if (typeof raw === 'string') return [raw];
      return undefined;
  }
}

/**
 * The single validation authority for command props: applies defaults, coerces the loose
 * values JSON/DSL/CDP callers send, and rejects unknown keys. Mirrors the role
 * `Agent.dispatch`'s zod `safeParse` plays for authoring tools.
 */
export function coerceProps(specs: PropSpecMap, raw: Record<string, unknown>): CoerceResult {
  const errors: string[] = [];
  const value: Record<string, PropValue> = {};

  for (const key of Object.keys(raw)) {
    if (!(key in specs)) errors.push(`unknown property "${key}"`);
  }

  for (const [name, spec] of Object.entries(specs)) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) {
      if (spec.required) errors.push(`missing required property "${name}"`);
      else if (spec.default !== undefined) value[name] = spec.default;
      continue;
    }
    const coerced = coerceOne(spec.kind, raw[name]);
    if (coerced === undefined) {
      errors.push(`property "${name}" expects ${spec.kind}, got ${JSON.stringify(raw[name])}`);
      continue;
    }
    if (spec.kind === 'enum' && !spec.values?.includes(coerced as string)) {
      errors.push(`property "${name}" must be one of ${spec.values?.join(' | ')}`);
      continue;
    }
    if (typeof coerced === 'number') {
      if (spec.min !== undefined && coerced < spec.min)
        errors.push(`property "${name}" must be >= ${spec.min}`);
      if (spec.max !== undefined && coerced > spec.max)
        errors.push(`property "${name}" must be <= ${spec.max}`);
    }
    value[name] = coerced;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
