/**
 * `@vn/contracts`: how a pipeline contract is declared in code, as data beside the code that
 * enforces it, so a model can ask which contracts apply to the file, command or tool in front of
 * it (`docs/reference/contracts.md`, "Declaring a contract").
 *
 * This entry carries no JSON and imports nothing, so any package, the desktop renderer included,
 * can declare a contract. The generated index and the functions that query it are the
 * `@vn/contracts/query` subpath.
 */

/**
 * The topics a contract id starts with. Topics rather than packages, so an id survives its code
 * moving between packages; the package is already in the `module:` subject.
 */
export type ContractArea =
  | 'identity'
  | 'storage'
  | 'log'
  | 'gate'
  | 'takes'
  | 'collect'
  | 'planning'
  | 'graphs'
  | 'script'
  | 'prompts'
  | 'execution'
  | 'providers';

/** Every area, for the generator, which checks ids that did not come through the type checker. */
export const CONTRACT_AREAS: readonly ContractArea[] = [
  'identity',
  'storage',
  'log',
  'gate',
  'takes',
  'collect',
  'planning',
  'graphs',
  'script',
  'prompts',
  'execution',
  'providers',
];

/** `<area>.<name>`, declared under the const `<area><Name>` (`vn/contract-decl` checks that). */
export type ContractId = `${ContractArea}.${string}`;

/**
 * What a contract is attached to. `slot:` is a slot address prefix, `task:` a task kind,
 * `command:` a command id and `tool:` an agent tool name. `package:` and `module:` are
 * repo-relative paths, and `function:` is a repo-relative path and an export
 * (`packages/scriptedit/src/lineops.ts#nextIdOf`). `file:` is a project-relative path such as
 * `state/tasks.jsonl`.
 */
export type SubjectPrefix =
  'slot' | 'task' | 'command' | 'tool' | 'package' | 'module' | 'function' | 'file';

/** Every subject prefix, for the generator and the query functions. */
export const SUBJECT_PREFIXES: readonly SubjectPrefix[] = [
  'slot',
  'task',
  'command',
  'tool',
  'package',
  'module',
  'function',
  'file',
];

export type Subject = `${SubjectPrefix}:${string}`;

/** A rule the code enforces, with the failure it prevents and the subjects it is attached to. */
export interface Contract<Id extends ContractId = ContractId> {
  readonly id: Id;
  /** What holds, as one checkable statement of at most 280 characters. */
  readonly rule: string;
  /** What breaks without it, at most 280 characters. */
  readonly prevents: string;
  readonly subjects: readonly Subject[];
  /** Plan and reference links, repo-relative, that carry the rule's history. */
  readonly see?: readonly string[];
  /** Anything longer than the two capped fields; a query returns it only when asked for in full. */
  readonly detail?: string;
}

/** Declares a contract. The value is frozen, so a declaration cannot be edited after it is read. */
export function contract<const Id extends ContractId>(spec: Contract<Id>): Contract<Id> {
  return Object.freeze({ ...spec, subjects: Object.freeze([...spec.subjects]) });
}

/** Titles a test block after the contract it pins: `describe(pins(gatePerUnit), …)`. */
export function pins(pinned: Contract): string {
  return `contract ${pinned.id}`;
}
