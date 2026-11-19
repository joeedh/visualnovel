/**
 * Builds the contract index from the declarations each package's and app's `contracts.ts` lists,
 * refuses it when any subject names nothing, and splits it into the files the generator writes:
 * `packages/contracts/contracts.json` and `packages/contracts/contracts/<area>.json`.
 *
 * Pure apart from reading the repo's files, so the generator (through `entry.ts`) and the jest
 * test that keeps the committed file current compute the same answer.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_AREAS, SUBJECT_PREFIXES, type Contract, type ContractArea } from '@vn/contracts';
import {
  areaOf,
  type ContractIndex,
  type ContractRecord,
  type ContractShard,
  type ContractSummaries,
} from '@vn/contracts/query';

/** One `contracts.ts` and the array it exports. */
export interface Declared {
  /** Repo-relative, forward-slashed. */
  file: string;
  contracts: readonly Contract[];
}

/** What subjects are checked against, gathered by `entry.ts` from the live registries. */
export interface Facts {
  commands: ReadonlySet<string>;
  /** The authoring agent's and the debug agent's tool names. */
  tools: ReadonlySet<string>;
  taskKinds: ReadonlySet<string>;
  /** The slot address prefixes the stills family's slot kinds declare. */
  slots: ReadonlySet<string>;
  /** Contracts a command definition carries in its `contracts` field. */
  commandContracts: readonly { command: string; contracts: readonly Contract[] }[];
  /** Contracts a slot kind carries in its `contracts` field, by the kind's prefix. */
  slotContracts: readonly { prefix: string; contracts: readonly Contract[] }[];
}

/** The files the generator writes: the summary file, and one shard per area, empty ones included. */
export interface IndexFiles {
  summary: ContractSummaries;
  shards: Record<ContractArea, ContractShard>;
}

/** Splits an index into the summary file and the shards, keeping its order in each. */
export function splitIndex(index: ContractIndex): IndexFiles {
  const shards = Object.fromEntries(
    CONTRACT_AREAS.map((area) => [area, { contracts: [] as ContractRecord[] }]),
  ) as Record<ContractArea, ContractShard>;
  for (const record of index.contracts) shards[areaOf(record.id)].contracts.push(record);
  return {
    summary: {
      contracts: index.contracts.map((c) => ({ id: c.id, rule: c.rule, subjects: c.subjects })),
      bySubject: index.bySubject,
    },
    shards,
  };
}

/** The longest a contract's `rule` or `prevents` may be. */
const MAX_FIELD = 280;

const ID = /^([a-z]+)\.([a-z][A-Za-z0-9]*)$/;

/** The const a contract id is declared under: `gate.perUnit` ↔ `gatePerUnit`. */
export function constNameOf(id: string): string | undefined {
  const m = ID.exec(id);
  if (!m || !m[1] || !m[2]) return undefined;
  return m[1] + m[2].charAt(0).toUpperCase() + m[2].slice(1);
}

/** The id a declaration's const name stands for, the inverse of {@link constNameOf}. */
export function idOfConst(name: string): string | undefined {
  const m = /^([a-z]+)([A-Z][A-Za-z0-9]*)$/.exec(name);
  if (!m || !m[1] || !m[2]) return undefined;
  return `${m[1]}.${m[2].charAt(0).toLowerCase()}${m[2].slice(1)}`;
}

/** The source root a `contracts.ts` belongs to: `packages/<name>/src` or `apps/<name>/src`. */
export function srcRootOf(file: string): string {
  const m = /^((packages|apps)\/[^/]+\/src)\//.exec(file);
  if (!m?.[1]) throw new Error(`${file} is not under packages/*/src or apps/*/src`);
  return m[1];
}

/** Every `.ts` file under `dir` that is not a test, repo-relative. */
export function sourceFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const at = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'tests', '__fixtures__'].includes(entry.name)) walk(at);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(at);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Each `export const X = contract(` in `srcRoot`, as const name → declaring file. */
export function declaredConsts(root: string, srcRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(root, srcRoot)) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/export\s+const\s+(\w+)\s*=\s*contract\s*\(/g)) {
      if (m[1]) found.set(m[1], file);
    }
  }
  return found;
}

/** Whether the module at `file` exports `name`, read from its source text. */
function exportsName(text: string, name: string): boolean {
  const declared = new RegExp(
    `export\\s+(declare\\s+)?(async\\s+)?(function\\*?|const|let|var|class|interface|type|enum)\\s+${name}\\b`,
  );
  if (declared.test(text)) return true;
  return [...text.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)].some((m) =>
    (m[2] ?? '').split(',').some(
      (part) =>
        part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)
          .pop() === name,
    ),
  );
}

/** Why `subject` names nothing, or undefined when it names something real. */
function subjectProblem(root: string, subject: string, facts: Facts): string | undefined {
  const colon = subject.indexOf(':');
  const prefix = subject.slice(0, colon);
  const rest = subject.slice(colon + 1);
  if (colon <= 0 || !(SUBJECT_PREFIXES as readonly string[]).includes(prefix)) {
    return `has no known prefix (${SUBJECT_PREFIXES.join(', ')})`;
  }
  if (!rest) return 'names nothing after its prefix';
  switch (prefix) {
    case 'slot':
      return facts.slots.has(rest) ? undefined : 'is not a declared slot kind prefix';
    case 'task':
      return facts.taskKinds.has(rest) ? undefined : 'is not a TaskKind';
    case 'command':
      return facts.commands.has(rest) ? undefined : 'is not a registered command';
    case 'tool':
      return facts.tools.has(rest) ? undefined : "is not in either agent's tool registry";
    case 'package':
      return existsSync(join(root, rest, 'package.json')) ? undefined : 'is not a package folder';
    case 'module':
      return existsSync(join(root, rest)) ? undefined : 'is not a file in the repo';
    case 'function': {
      const [file, name] = rest.split('#');
      if (!file || !name) return 'is not `<path>#<export>`';
      if (!existsSync(join(root, file))) return 'names a file that is not in the repo';
      return exportsName(readFileSync(join(root, file), 'utf8'), name)
        ? undefined
        : `names an export ${file} does not have`;
    }
    case 'file':
      return rest.startsWith('/') || rest.split('/').includes('..')
        ? 'is not a project-relative path'
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The index for `declared`, or an error listing every problem: a malformed or duplicate id, an
 * over-long field, a subject that names nothing, a `see` link to a missing file, or a declaration
 * whose const cannot be found in its package's source.
 */
export function buildIndex(
  root: string,
  declared: readonly Declared[],
  facts: Facts,
): ContractIndex {
  const problems: string[] = [];
  const records = new Map<string, ContractRecord>();

  for (const { file, contracts } of declared) {
    const consts = declaredConsts(root, srcRootOf(file));
    for (const c of contracts) {
      const where = `${c.id} (${file})`;
      const area = ID.exec(c.id)?.[1];
      if (!area || !(CONTRACT_AREAS as readonly string[]).includes(area)) {
        problems.push(`${where}: the id is not <area>.<name> with a known area`);
        continue;
      }
      if (records.has(c.id)) {
        problems.push(`${where}: the id is declared twice`);
        continue;
      }
      for (const field of ['rule', 'prevents'] as const) {
        if (!c[field].trim()) problems.push(`${where}: \`${field}\` is empty`);
        if (c[field].length > MAX_FIELD)
          problems.push(`${where}: \`${field}\` is over ${MAX_FIELD}`);
      }
      if (c.subjects.length === 0) problems.push(`${where}: it has no subjects`);
      for (const subject of c.subjects) {
        const problem = subjectProblem(root, subject, facts);
        if (problem) problems.push(`${where}: subject "${subject}" ${problem}`);
      }
      for (const link of c.see ?? []) {
        const path = link.split('#')[0] ?? '';
        if (!existsSync(join(root, path))) problems.push(`${where}: see "${link}" is not a file`);
      }
      const name = constNameOf(c.id) ?? '';
      const at = consts.get(name);
      if (!at)
        problems.push(`${where}: no \`export const ${name} = contract(\` in ${srcRootOf(file)}`);
      records.set(c.id, {
        id      : c.id,
        rule    : c.rule,
        prevents: c.prevents,
        subjects: [...c.subjects],
        ...(c.see?.length ? { see: [...c.see] } : {}),
        ...(c.detail ? { detail: c.detail } : {}),
        declared: at ?? file,
      });
    }
  }

  const carried = [
    ...facts.commandContracts.map((c) => ({
      by       : `command ${c.command}`,
      subject  : `command:${c.command}`,
      contracts: c.contracts,
    })),
    ...facts.slotContracts.map((k) => ({
      by       : `slot kind ${k.prefix}`,
      subject  : `slot:${k.prefix}`,
      contracts: k.contracts,
    })),
  ];
  for (const { by, subject, contracts } of carried) {
    for (const c of contracts) {
      const record = records.get(c.id);
      if (!record) {
        problems.push(`${c.id}: ${by} carries it, but no contracts.ts lists it`);
        continue;
      }
      if (!record.subjects.includes(subject)) record.subjects.push(subject);
    }
  }

  if (problems.length > 0) {
    throw new Error(`The contract index was refused:\n- ${problems.join('\n- ')}`);
  }

  const contracts = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  const bySubject: Record<string, string[]> = {};
  for (const c of contracts) {
    for (const subject of c.subjects) (bySubject[subject] ??= []).push(c.id);
  }
  const sorted = Object.fromEntries(
    Object.keys(bySubject)
      .sort()
      .map((k) => [k, bySubject[k]!.sort()]),
  );
  return { contracts, bySubject: sorted };
}
