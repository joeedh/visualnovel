/**
 * The serializable projection of a registry — emitted at build time to `commands.json` and
 * served live over IPC. Includes a JSON Schema per command so external tooling (and, later,
 * provider-native function calling) can consume the surface without importing this package.
 */
import { formatCommand } from './dsl.js';
import { toInteractionCatalog, type InteractionCatalogEntry } from './interaction.js';
import type { CommandRegistry } from './registry.js';
import type { InteractionRegistry } from './interaction.js';
import type { Prop, PropKind, PropValue } from './props.js';

export interface CatalogProp {
  name: string;
  kind: PropKind;
  description: string;
  required: boolean;
  default?: PropValue;
  values?: readonly string[];
  /** Bulk content (`digest.ts`). A form describes the value rather than offering a field for it. */
  digest?: boolean;
  /** Free text of more than a line. A form draws a box to write in. */
  multiline?: boolean;
  /** The hover sentence, where `description` is drawn as a label instead. */
  hint?: string;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  mutating: boolean;
  confirm: boolean;
  undoable: boolean;
  /** Whether `stack.check` has a precondition to consult. False means `undeclared`, not `accept`. */
  checkable: boolean;
  props: CatalogProp[];
  /** A ready-to-paste DSL template, e.g. `gate.approve(characterId='' hash='')`. */
  usage: string;
  schema: JsonSchema;
}

/** One prop as documentation needs it — no `usage`/`schema`-only fields. */
export interface DocProp {
  name: string;
  kind: PropKind;
  description: string;
  required: boolean;
  default?: PropValue;
  values?: readonly string[];
  /** Bulk content (`digest.ts`) — the table marks it rather than showing a default. */
  digest?: boolean;
}

/**
 * The doc-only projection of a registry, consumed solely by `scripts/gen-command-table.mjs`.
 * Deliberately a different shape than `CatalogEntry`: `notes` must never ride along with
 * whatever `toCatalog` produces, because that object is served over `command:catalog` and read
 * for UI tooltip defaults.
 */
export interface DocCommandEntry {
  id: string;
  namespace: string;
  title: string;
  mutating: boolean;
  confirm: boolean;
  undoable: boolean;
  /** Whether `stack.check` has a precondition to consult. False means `undeclared`, not `accept`. */
  checkable: boolean;
  notes?: string;
  props: DocProp[];
}

export function toDocIndex(registry: CommandRegistry<any>): DocCommandEntry[] {
  return registry.list().map<DocCommandEntry>((command) => ({
    id: command.id,
    namespace: command.id.split('.')[0]!,
    title: command.title,
    mutating: command.mutating,
    confirm: command.confirm ?? false,
    undoable: command.undoable ?? false,
    checkable: Boolean(command.check),
    ...(command.notes ? { notes: command.notes } : {}),
    props: Object.entries(command.props).map(([name, spec]) => ({
      name,
      kind: spec.kind,
      description: spec.description,
      required: spec.required,
      ...(spec.default !== undefined ? { default: spec.default } : {}),
      ...(spec.values ? { values: [...spec.values] } : {}),
      ...(spec.digest ? { digest: true } : {}),
    })),
  }));
}

export interface CommandCatalog {
  version: 1;
  /** Which registry this was generated from, e.g. `@vn/desktop`. */
  source: string;
  commands: CatalogEntry[];
  /**
   * The gesture surface, when the host declares one. Additive and optional: a consumer that
   * only knows about commands reads the same file unchanged.
   */
  interactions?: InteractionCatalogEntry[];
}

/** A placeholder of the right type, so `usage` is a template the user can fill in. */
function placeholder(spec: Prop<PropValue, boolean>): PropValue {
  if (spec.default !== undefined) return spec.default;
  switch (spec.kind) {
    case 'number':
      return spec.min ?? 0;
    case 'boolean':
      return false;
    case 'enum':
      return spec.values?.[0] ?? '';
    case 'string[]':
      return [];
    default:
      return '';
  }
}

function jsonType(spec: Prop<PropValue, boolean>): Record<string, unknown> {
  switch (spec.kind) {
    case 'number':
      return {
        type: 'number',
        ...(spec.min !== undefined ? { minimum: spec.min } : {}),
        ...(spec.max !== undefined ? { maximum: spec.max } : {}),
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'string', enum: [...(spec.values ?? [])] };
    case 'string[]':
      return { type: 'array', items: { type: 'string' } };
    default:
      return { type: 'string' };
  }
}

export function toCatalog(
  registry: CommandRegistry<any>,
  source: string,
  interactions?: InteractionRegistry<any>,
): CommandCatalog {
  const commands = registry.list().map<CatalogEntry>((command) => {
    const entries = Object.entries(command.props);
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    const template: Record<string, PropValue> = {};

    for (const [name, spec] of entries) {
      properties[name] = {
        ...jsonType(spec),
        description: spec.description,
        ...(spec.default !== undefined ? { default: spec.default } : {}),
      };
      if (spec.required) required.push(name);
      template[name] = placeholder(spec);
    }

    return {
      id: command.id,
      title: command.title,
      description: command.description,
      mutating: command.mutating,
      confirm: command.confirm ?? false,
      undoable: command.undoable ?? false,
      checkable: Boolean(command.check),
      props: entries.map(([name, spec]) => ({
        name,
        kind: spec.kind,
        description: spec.description,
        required: spec.required,
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        ...(spec.values ? { values: [...spec.values] } : {}),
        ...(spec.digest ? { digest: true } : {}),
        ...(spec.multiline ? { multiline: true } : {}),
        ...(spec.hint ? { hint: spec.hint } : {}),
      })),
      usage: formatCommand(command.id, template),
      schema: { type: 'object', properties, required, additionalProperties: false },
    };
  });

  return {
    version: 1,
    source,
    commands,
    ...(interactions ? { interactions: toInteractionCatalog(interactions) } : {}),
  };
}
