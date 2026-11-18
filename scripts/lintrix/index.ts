/**
 * Lintrix rules for the package layering: `vn/element-types` (which packages may import
 * which) and `vn/no-cycle` (no runtime import cycles). They replace
 * `eslint-plugin-boundaries` and `import/no-cycle`. The layer table is rule options in
 * `lintrix.config.json`; this module only knows how to resolve and walk imports.
 *
 * One file, because lintrix imports a `.ts` plugin through Node's type stripping, which
 * needs `.ts` extensions on relative imports and the repo's tsconfig forbids them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { configNames, lint, loadAddon, NodeKind, resolveRule } from 'lintrix';
import type { Node, Rule, RuleContext } from 'lintrix';

// ─── Import extraction ──────────────────────────────────────────────────────

/** One module reference in a file. */
interface Dep {
  readonly spec: string;
  /** Erased at runtime: `import type`, `export type … from`, or every specifier `type`. */
  readonly typeOnly: boolean;
  readonly node: Node;
}

const VALUE = 0; // ImportKind.Value in lintrix's generated views
const CONST = 2; // VariableKind.Const, likewise

/** The contents of a string literal or substitution-free template, or undefined. */
function stringValue(node: Node | null): string | undefined {
  if (!node) return undefined;
  const text = node.text;
  const quote = text.charAt(0);
  if (text.length < 2 || !text.endsWith(quote)) return undefined;
  if (quote === '"' || quote === "'") return text.slice(1, -1);
  if (quote === '`' && !text.includes('${')) return text.slice(1, -1);
  return undefined;
}

/** True when there is at least one specifier and every one is marked `type`. */
function allTypeSpecifiers(specifiers: readonly Node[]): boolean {
  if (specifiers.length === 0) return false;
  return specifiers.every((s) => {
    if (s.is(NodeKind.ImportSpecifier)) return s.importKind !== VALUE;
    if (s.is(NodeKind.ExportSpecifier)) return s.exportKind !== VALUE;
    return false;
  });
}

/** The module reference `node` makes, if it makes one. */
function depOf(node: Node): Dep | undefined {
  let spec: string | undefined;
  let typeOnly = false;
  if (node.is(NodeKind.ImportDeclaration)) {
    spec = stringValue(node.source);
    typeOnly = node.importKind !== VALUE || allTypeSpecifiers(node.specifiers);
  } else if (node.is(NodeKind.ExportNamedDeclaration)) {
    spec = stringValue(node.source);
    typeOnly = node.exportKind !== VALUE || allTypeSpecifiers(node.specifiers);
  } else if (node.is(NodeKind.ExportAllDeclaration)) {
    spec = stringValue(node.source);
    typeOnly = node.exportKind !== VALUE;
  } else if (node.is(NodeKind.ImportExpression)) {
    spec = stringValue(node.source);
  } else if (node.is(NodeKind.TSImportEqualsDeclaration)) {
    const ref = node.moduleReference;
    if (ref.is(NodeKind.TSExternalModuleReference)) spec = stringValue(ref.expression);
    typeOnly = node.importKind !== VALUE;
  }
  return spec === undefined ? undefined : { spec, typeOnly, node };
}

/** Visitors that hand every module reference in a file to `onDep`. */
function depVisitors(onDep: (dep: Dep) => void): Record<string, (node: Node) => void> {
  const visit = (node: Node): void => {
    const dep = depOf(node);
    if (dep) onDep(dep);
  };
  return {
    ImportDeclaration        : visit,
    ExportNamedDeclaration   : visit,
    ExportAllDeclaration     : visit,
    ImportExpression         : visit,
    TSImportEqualsDeclaration: visit,
  };
}

// ─── Resolution ─────────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';

/** Forward slashes, and lower case on Windows, where the filesystem ignores case. */
function key(file: string): string {
  const slashed = file.replace(/\\/g, '/');
  return WIN ? slashed.toLowerCase() : slashed;
}

/** Parses tsconfig's JSON dialect: comments and trailing commas allowed. */
function readJsonc(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
}

/** The file `TS_EXTS` maps a written extension to, tried in order. */
const TS_EXTS: Record<string, string[]> = {
  '.js' : ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};
const BARE_EXTS = ['.ts', '.tsx', '.d.ts', '.mts', '.js', '.mjs'];

/** A tsconfig `paths` entry, split at its `*` if it has one. */
interface PathAlias {
  readonly prefix: string;
  readonly suffix: string | undefined;
  readonly targets: readonly string[];
}

/**
 * The files of one lintrix project: the directory holding the config, its tsconfig
 * `paths`, and the workspace packages reachable through `node_modules`. Resolves a
 * specifier the way the TypeScript resolver does for this repo's settings.
 */
class Workspace {
  readonly root: string;
  private readonly aliases: PathAlias[] = [];
  private readonly isFileMemo = new Map<string, boolean>();
  private readonly resolveMemo = new Map<string, string | undefined>();
  /** Realpath of each resolved file, so one file is one graph node. */
  private readonly realMemo = new Map<string, string>();

  constructor(root: string, tsconfig: string) {
    this.root = root;
    const file = path.resolve(root, tsconfig);
    if (!fs.existsSync(file)) return;
    const config = readJsonc(file) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const base = path.resolve(path.dirname(file), config.compilerOptions?.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
      const star = pattern.indexOf('*');
      this.aliases.push({
        prefix : star < 0 ? pattern : pattern.slice(0, star),
        suffix : star < 0 ? undefined : pattern.slice(star + 1),
        targets: targets.map((t) => path.resolve(base, t)),
      });
    }
  }

  /** The path relative to the root, with forward slashes. */
  relative(file: string): string {
    return path.relative(this.root, file).replace(/\\/g, '/');
  }

  /** The canonical spelling of an existing file. */
  real(file: string): string {
    let real = this.realMemo.get(file);
    if (real === undefined) {
      real = fs.realpathSync.native(file);
      this.realMemo.set(file, real);
    }
    return real;
  }

  /** The source file `spec` names from `fromFile`, or undefined for an external module. */
  resolve(fromFile: string, spec: string): string | undefined {
    const dir = path.dirname(fromFile);
    const memoKey = spec.startsWith('.') ? `${dir}\0${spec}` : spec;
    if (this.resolveMemo.has(memoKey)) return this.resolveMemo.get(memoKey);
    let found: string | undefined;
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      found = this.fileAt(path.resolve(dir, spec));
    } else if (!spec.startsWith('node:')) {
      found = this.viaAlias(spec) ?? this.viaWorkspace(dir, spec);
    }
    if (found !== undefined) found = this.real(found);
    this.resolveMemo.set(memoKey, found);
    return found;
  }

  private isFile(file: string): boolean {
    let is = this.isFileMemo.get(file);
    if (is === undefined) {
      is = fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
      this.isFileMemo.set(file, is);
    }
    return is;
  }

  /** The file a written path names, trying TypeScript's extension substitutions. */
  private fileAt(target: string): string | undefined {
    const ext = path.extname(target);
    for (const alt of TS_EXTS[ext] ?? []) {
      const candidate = target.slice(0, -ext.length) + alt;
      if (this.isFile(candidate)) return candidate;
    }
    if (this.isFile(target)) return target;
    for (const alt of BARE_EXTS) {
      if (this.isFile(target + alt)) return target + alt;
    }
    for (const alt of BARE_EXTS) {
      const index = path.join(target, `index${alt}`);
      if (this.isFile(index)) return index;
    }
    return undefined;
  }

  private viaAlias(spec: string): string | undefined {
    for (const alias of this.aliases) {
      let fill: string;
      if (alias.suffix === undefined) {
        if (spec !== alias.prefix) continue;
        fill = '';
      } else {
        if (!spec.startsWith(alias.prefix) || !spec.endsWith(alias.suffix)) continue;
        if (spec.length < alias.prefix.length + alias.suffix.length) continue;
        fill = spec.slice(alias.prefix.length, spec.length - alias.suffix.length);
      }
      for (const target of alias.targets) {
        const found = this.fileAt(target.replace('*', fill));
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * A workspace package reached through its `node_modules` symlink, whose real path is
   * outside every `node_modules`. A package that really lives in `node_modules` is
   * external and resolves to undefined.
   */
  private viaWorkspace(dir: string, spec: string): string | undefined {
    const parts = spec.split('/');
    const nameLength = spec.startsWith('@') ? 2 : 1;
    const name = parts.slice(0, nameLength).join('/');
    const subpath = parts.length > nameLength ? `./${parts.slice(nameLength).join('/')}` : '.';
    for (let at = dir; ; at = path.dirname(at)) {
      const link = path.join(at, 'node_modules', name);
      if (fs.existsSync(link)) {
        const pkgDir = fs.realpathSync.native(link);
        if (/[\\/]node_modules[\\/]/.test(pkgDir)) return undefined;
        return this.viaExports(pkgDir, subpath);
      }
      if (path.dirname(at) === at) return undefined;
    }
  }

  private viaExports(pkgDir: string, subpath: string): string | undefined {
    const manifest = path.join(pkgDir, 'package.json');
    if (!this.isFile(manifest)) return this.fileAt(path.join(pkgDir, subpath));
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      exports?: unknown;
      main?: string;
    };
    let target: string | undefined;
    if (typeof pkg.exports === 'string' || isConditions(pkg.exports)) {
      if (subpath === '.') target = pickCondition(pkg.exports);
    } else if (pkg.exports && typeof pkg.exports === 'object') {
      const map = pkg.exports as Record<string, unknown>;
      target = pickCondition(map[subpath]);
      for (const [pattern, value] of Object.entries(map)) {
        if (target !== undefined) break;
        const star = pattern.indexOf('*');
        if (star < 0) continue;
        const [before, after] = [pattern.slice(0, star), pattern.slice(star + 1)];
        if (!subpath.startsWith(before) || !subpath.endsWith(after)) continue;
        const fill = subpath.slice(before.length, subpath.length - after.length);
        target = pickCondition(value)?.replace('*', fill);
      }
    } else if (subpath === '.') {
      target = pkg.main ?? './index.js';
    } else {
      target = subpath;
    }
    return target === undefined ? undefined : this.fileAt(path.resolve(pkgDir, target));
  }
}

/** True for an `exports` object keyed by conditions rather than by subpaths. */
function isConditions(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).every((k) => !k.startsWith('.'));
}

/** The first string an `exports` value yields under the conditions TypeScript uses. */
function pickCondition(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickCondition(item);
      if (picked !== undefined) return picked;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const conditions = value as Record<string, unknown>;
  for (const condition of ['types', 'import', 'node', 'default']) {
    if (condition in conditions) {
      const picked = pickCondition(conditions[condition]);
      if (picked !== undefined) return picked;
    }
  }
  return undefined;
}

const workspaces = new Map<string, Workspace>();

/** The directory holding the lintrix config that governs `file`. */
function configRoot(file: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (configNames.some((name) => fs.existsSync(path.join(dir, name)))) return dir;
    if (path.dirname(dir) === dir) return path.dirname(file);
  }
}

/** The workspace for the file `context` lints, shared by every rule in this run. */
function workspaceFor(context: RuleContext): Workspace {
  const options = (context.options[0] ?? {}) as { tsconfig?: string };
  const root = configRoot(path.resolve(context.filename));
  const tsconfig = options.tsconfig ?? 'tsconfig.json';
  const id = `${root}\0${tsconfig}`;
  let ws = workspaces.get(id);
  if (!ws) {
    ws = new Workspace(root, tsconfig);
    workspaces.set(id, ws);
  }
  return ws;
}

// ─── vn/element-types ───────────────────────────────────────────────────────

/** `vn/element-types`'s one option object. */
interface LayerOptions {
  /**
   * Element name → what belongs to it, relative to the config: a folder and every file under it,
   * or one source file, named with its extension.
   */
  readonly elements: Record<string, string>;
  /** Element name → the other elements its files may import. */
  readonly allow: Record<string, readonly string[]>;
  readonly tsconfig?: string;
}

/** A path that names one source file rather than a folder. */
const FILE_ELEMENT = /\.[cm]?tsx?$/;

/**
 * Elements as path keys, longest first, so a file or a nested folder wins over the folder that
 * holds it. A folder's key ends in `/`; a file's is the file's own path.
 */
interface Layers {
  readonly paths: readonly (readonly [string, string])[];
  readonly allow: ReadonlyMap<string, ReadonlySet<string>>;
}

const layersMemo = new WeakMap<object, Layers>();

/** Validates the option object once and indexes it. Throws on a misspelled element. */
function layersOf(raw: unknown): Layers {
  if (!raw || typeof raw !== 'object') {
    throw new Error("vn/element-types needs an options object with 'elements' and 'allow'");
  }
  const cached = layersMemo.get(raw);
  if (cached) return cached;
  const options = raw as LayerOptions;
  const names = new Set(Object.keys(options.elements ?? {}));
  if (names.size === 0) throw new Error("vn/element-types: 'elements' is empty");
  const allow = new Map<string, Set<string>>();
  for (const [from, list] of Object.entries(options.allow ?? {})) {
    for (const name of [from, ...list]) {
      if (!names.has(name)) {
        throw new Error(`vn/element-types: 'allow' names '${name}', which 'elements' lacks`);
      }
    }
    allow.set(from, new Set(list));
  }
  const paths = Object.entries(options.elements)
    .map(([name, where]) => {
      const trimmed = key(where).replace(/\/+$/, '');
      return [FILE_ELEMENT.test(trimmed) ? trimmed : `${trimmed}/`, name] as const;
    })
    .sort((a, b) => b[0].length - a[0].length);
  const layers = { paths, allow };
  layersMemo.set(raw, layers);
  return layers;
}

/** The element `file` belongs to, or undefined when no element names it or a folder holding it. */
function elementOf(layers: Layers, ws: Workspace, file: string): string | undefined {
  const rel = key(ws.relative(file));
  return layers.paths.find(([at]) => (at.endsWith('/') ? rel.startsWith(at) : rel === at))?.[1];
}

/**
 * Refuses an import, re-export or dynamic import from one element into another that its
 * `allow` entry does not list. An element may always import itself, and a file or target
 * outside every element (an npm package, `scripts/`, `vendor/`) is not checked.
 * Type-only imports are checked too: they still couple the packages.
 */
const elementTypes: Rule = {
  name    : 'element-types',
  messages: {
    disallowed:
      "'{{from}}' may not import '{{to}}': lintrix.config.json does not list '{{to}}' in " +
      "the vn/element-types 'allow' entry for '{{from}}'.",
  },
  create(context) {
    const layers = layersOf(context.options[0]);
    const ws = workspaceFor(context);
    const file = path.resolve(context.filename);
    const from = elementOf(layers, ws, file);
    if (from === undefined) return {};
    const allowed = layers.allow.get(from) ?? new Set<string>();
    return depVisitors((dep) => {
      const target = ws.resolve(file, dep.spec);
      if (target === undefined) return;
      const to = elementOf(layers, ws, target);
      if (to === undefined || to === from || allowed.has(to)) return;
      context.report({ node: dep.node, messageId: 'disallowed', data: { from, to } });
    });
  },
};

// ─── vn/no-cycle ────────────────────────────────────────────────────────────

/** Lintrix's own parser, for reading the files the current one imports. */
const parser = await loadAddon();

/**
 * The runtime import graph of a workspace, built lazily from disk and kept for the
 * process, which is one lint run. Tarjan's algorithm labels each strongly connected
 * component as the walk finishes it; a finished label never changes, so a later walk
 * from another file reuses every label an earlier one assigned.
 */
class ImportGraph {
  private readonly edges = new Map<string, string[]>();
  private readonly index = new Map<string, number>();
  private readonly low = new Map<string, number>();
  private readonly component = new Map<string, number>();
  private readonly stack: string[] = [];
  private readonly onStack = new Set<string>();
  private counter = 0;
  private readonly ws: Workspace;

  constructor(ws: Workspace) {
    this.ws = ws;
  }

  /** True when `to` can reach `from` again, so the edge `from → to` closes a cycle. */
  closesCycle(from: string, to: string): boolean {
    if (from === to) return true;
    this.visit(from);
    this.visit(to);
    return this.component.get(from) === this.component.get(to);
  }

  /** The shortest import chain from `start` back to `goal`, both included. */
  chain(start: string, goal: string): string[] {
    const comp = this.component.get(goal);
    const previous = new Map<string, string>([[start, start]]);
    const queue = [start];
    // An array iterator also yields the items pushed while it runs
    for (const at of queue) {
      if (at === goal) break;
      for (const next of this.edgesOf(at)) {
        if (previous.has(next) || this.component.get(next) !== comp) continue;
        previous.set(next, at);
        queue.push(next);
      }
    }
    const chain = [goal];
    for (let at = goal; at !== start;) {
      at = previous.get(at) ?? start;
      chain.push(at);
    }
    return chain.reverse();
  }

  /** The files `file` imports at runtime, read from disk on first use. */
  private edgesOf(file: string): string[] {
    let out = this.edges.get(file);
    if (out) return out;
    out = [];
    this.edges.set(file, out);
    if (!traversable(file)) return out;
    const deps: Dep[] = [];
    const collector: Rule = { name: 'collect', create: () => depVisitors((d) => deps.push(d)) };
    lint(parser, fs.readFileSync(file, 'utf8'), file, [resolveRule(collector)]);
    for (const dep of deps) {
      if (dep.typeOnly) continue;
      const target = this.ws.resolve(file, dep.spec);
      if (target !== undefined && traversable(target)) out.push(target);
    }
    return out;
  }

  private visit(file: string): void {
    if (this.index.has(file)) return;
    this.index.set(file, this.counter);
    this.low.set(file, this.counter);
    this.counter++;
    this.stack.push(file);
    this.onStack.add(file);
    for (const next of this.edgesOf(file)) {
      if (!this.index.has(next)) {
        this.visit(next);
        this.low.set(file, Math.min(this.low.get(file)!, this.low.get(next)!));
      } else if (this.onStack.has(next)) {
        this.low.set(file, Math.min(this.low.get(file)!, this.index.get(next)!));
      }
    }
    if (this.low.get(file) !== this.index.get(file)) return;
    const id = this.index.get(file)!;
    let member: string;
    do {
      member = this.stack.pop()!;
      this.onStack.delete(member);
      this.component.set(member, id);
    } while (member !== file);
  }
}

/** False for declaration files, which emit nothing, and for installed packages. */
function traversable(file: string): boolean {
  return !/\.d\.[cm]?ts$/.test(file) && !/[\\/]node_modules[\\/]/.test(file);
}

const graphs = new WeakMap<Workspace, ImportGraph>();

/**
 * Refuses a runtime import, re-export or dynamic import whose target imports this file
 * back, directly or through other files. Type-only imports are erased and do not count.
 * The report sits on the import that enters the cycle and names the chain that closes it.
 */
const noCycle: Rule = {
  name    : 'no-cycle',
  messages: {
    cycle: 'Import cycle: {{chain}}.',
  },
  create(context) {
    const ws = workspaceFor(context);
    const graph = graphs.get(ws) ?? new ImportGraph(ws);
    graphs.set(ws, graph);
    const file = ws.real(path.resolve(context.filename));
    return depVisitors((dep) => {
      if (dep.typeOnly) return;
      const target = ws.resolve(file, dep.spec);
      if (target === undefined || !traversable(target)) return;
      if (!graph.closesCycle(file, target)) return;
      const chain = graph
        .chain(target, file)
        .map((f) => ws.relative(f))
        .join(' → ');
      context.report({
        node     : dep.node,
        messageId: 'cycle',
        data     : { chain: `${ws.relative(file)} → ${chain}` },
      });
    });
  },
};

// ─── vn/contract-decl and vn/contract-pins ──────────────────────────────────

/** `<area>.<name>`; the area list itself is `ContractArea`'s, which TypeScript checks. */
const CONTRACT_ID = /^([a-z]+)\.([a-z][A-Za-z0-9]*)$/;

/** The longest a contract's `rule` or `prevents` may be; anything longer belongs in `detail`. */
const MAX_CONTRACT_FIELD = 280;

/** The const a contract id is declared under: `gate.perUnit` ↔ `gatePerUnit`. */
function contractConstName(id: string): string | undefined {
  const m = CONTRACT_ID.exec(id);
  if (!m) return undefined;
  const [, area, name] = m as unknown as [string, string, string];
  return area + name.charAt(0).toUpperCase() + name.slice(1);
}

/** The path of the file `context` lints, relative to its config, with forward slashes. */
function relativeFile(context: RuleContext): string {
  const file = path.resolve(context.filename);
  return path.relative(configRoot(file), file).replace(/\\/g, '/');
}

/** True for a source file under `packages/<name>/src/` or `apps/<name>/src/` that is not a test. */
function declarable(rel: string): boolean {
  if (!/^(packages|apps)\/[^/]+\/src\//.test(rel)) return false;
  return !/\.test\.[cm]?tsx?$/.test(rel) && !/(^|\/)(tests|__fixtures__)\//.test(rel);
}

/** True when `call` calls a bare identifier called `name`. */
function calls(call: Node, name: string): boolean {
  return (
    call.is(NodeKind.CallExpression) &&
    call.callee.is(NodeKind.Identifier) &&
    call.callee.text === name
  );
}

/** The value node of the object literal property `key`, or undefined. */
function propertyOf(object: Node, key: string): Node | undefined {
  if (!object.is(NodeKind.ObjectExpression)) return undefined;
  for (const prop of object.properties) {
    if (!prop.is(NodeKind.Property) || prop.isComputed) continue;
    const name = prop.key.is(NodeKind.Identifier) ? prop.key.text : stringValue(prop.key);
    if (name === key) return prop.value;
  }
  return undefined;
}

/**
 * Checks each `contract({...})` call: it sits in a package's or app's source, outside its tests;
 * it is the initializer of an exported `const` named after its id; its id, `rule` and `prevents`
 * are string literals; and `rule` and `prevents` fit {@link MAX_CONTRACT_FIELD}.
 */
const contractDecl: Rule = {
  name    : 'contract-decl',
  messages: {
    misplaced:
      'A contract is declared only in packages/*/src/ or apps/*/src/, outside tests, so the ' +
      'index generator and the listing test can find it.',
    notExported    : 'Declare a contract as `export const <name> = contract({...})`.',
    idNotLiteral   : "A contract's `id` must be a string literal of the form `<area>.<name>`.",
    misnamed       : "Contract '{{id}}' must be declared as `{{expected}}`, not `{{actual}}`.",
    fieldNotLiteral:
      "A contract's `{{field}}` must be a string literal, so the index carries it verbatim.",
    tooLong:
      "A contract's `{{field}}` is {{length}} characters; the limit is {{limit}}. Move the rest into `detail`.",
  },
  create(context) {
    const rel = relativeFile(context);
    return {
      Program(program) {
        for (const call of program.descendants(NodeKind.CallExpression)) {
          if (!calls(call, 'contract')) continue;
          if (!declarable(rel)) {
            context.report({ node: call, messageId: 'misplaced' });
            continue;
          }
          const declarator = call.parent;
          const declaration = declarator?.parent;
          if (
            !declarator?.is(NodeKind.VariableDeclarator) ||
            !declarator.id.is(NodeKind.Identifier) ||
            !declaration?.is(NodeKind.VariableDeclaration) ||
            declaration.kind !== CONST ||
            !declaration.parent?.is(NodeKind.ExportNamedDeclaration)
          ) {
            context.report({ node: call, messageId: 'notExported' });
            continue;
          }
          const spec = call.arguments[0];
          const id = spec ? stringValue(propertyOf(spec, 'id') ?? null) : undefined;
          const expected = id === undefined ? undefined : contractConstName(id);
          if (!spec || id === undefined || expected === undefined) {
            context.report({ node: call, messageId: 'idNotLiteral' });
            continue;
          }
          const actual = declarator.id.text;
          if (actual !== expected) {
            context.report({ node: call, messageId: 'misnamed', data: { id, expected, actual } });
          }
          for (const field of ['rule', 'prevents']) {
            const value = stringValue(propertyOf(spec, field) ?? null);
            if (value === undefined) {
              context.report({ node: call, messageId: 'fieldNotLiteral', data: { field } });
            } else if (value.length > MAX_CONTRACT_FIELD) {
              context.report({
                node     : call,
                messageId: 'tooLong',
                data: { field, length: String(value.length), limit: String(MAX_CONTRACT_FIELD) },
              });
            }
          }
        }
      },
    };
  },
};

/**
 * Requires `pins(x)`'s argument to be an identifier imported under its own name, so the coverage
 * test can map `pins(gatePerUnit)` to `gate.perUnit` by the naming rule alone.
 */
const contractPins: Rule = {
  name    : 'contract-pins',
  messages: {
    notImported:
      '`pins` takes the contract itself, imported under its own name (no `as`), so the coverage ' +
      'test can read its id off the identifier.',
  },
  create(context) {
    return {
      Program(program) {
        const imported = new Map<string, string>();
        for (const spec of program.descendants(NodeKind.ImportSpecifier)) {
          imported.set(spec.local.text, spec.imported.text);
        }
        for (const call of program.descendants(NodeKind.CallExpression)) {
          if (!calls(call, 'pins')) continue;
          const [arg, ...rest] = call.arguments;
          const ok =
            arg !== undefined &&
            rest.length === 0 &&
            arg.is(NodeKind.Identifier) &&
            imported.get(arg.text) === arg.text;
          if (!ok) context.report({ node: call, messageId: 'notImported' });
        }
      },
    };
  },
};

export default {
  rules: {
    'element-types': elementTypes,
    'no-cycle'     : noCycle,
    'contract-decl': contractDecl,
    'contract-pins': contractPins,
  },
};
