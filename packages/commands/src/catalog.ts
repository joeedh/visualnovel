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
  props: CatalogProp[];
  /** A ready-to-paste DSL template, e.g. `gate.approve(characterId='' hash='')`. */
  usage: string;
  schema: JsonSchema;
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
      props: entries.map(([name, spec]) => ({
        name,
        kind: spec.kind,
        description: spec.description,
        required: spec.required,
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        ...(spec.values ? { values: [...spec.values] } : {}),
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
