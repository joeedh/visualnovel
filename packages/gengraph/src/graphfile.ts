import {
  readJSON,
  validateJSON,
  writeJSON,
  type StructableClass,
  type StructableInstance,
} from 'nstructjs';
import { Graph, GroupDef } from 'pathux-graph';
import type { ToolProperty } from 'pathux-toolprop';

export type GraphFileDiagnosticCode = 'malformed-graph-file' | 'unreadable-graph-file';

/** Which layout a file was read against, which is all a malformed-file sentence needs. */
type FileKind = 'graph' | 'group';

export interface GraphFileDiagnostic {
  code: GraphFileDiagnosticCode;
  message: string;
}

export interface GraphFileRead {
  /** Absent whenever the diagnostics list is non-empty. */
  graph?: Graph;
  diagnostics: GraphFileDiagnostic[];
}

/** The graph as JSON values. The caller decides where the bytes go. */
export function writeGraphFile(graph: Graph): Record<string, unknown> {
  return writeJSON(graph);
}

/**
 * Reads a graph from JSON values, validating at the boundary. A file that does not
 * match the STRUCT layout produces diagnostics rather than a throw, so a host can
 * report the failure against the document the author opened.
 */
export function readGraphFile(json: unknown): GraphFileRead {
  const read = readStruct(json, Graph, 'graph');
  if (read.value === undefined) return { diagnostics: read.diagnostics };

  restampDeclared(read.value);
  return { graph: read.value, diagnostics: read.diagnostics };
}

/** The group definition as JSON values, for one file under the project's graph library. */
export function writeGroupFile(def: GroupDef): Record<string, unknown> {
  return writeJSON(def);
}

/**
 * Reads a group definition from JSON values. A definition is validated the way a graph is,
 * because a group carries a whole subgraph and a malformed one would otherwise be reconciled
 * into every graph that references it.
 */
export function readGroupFile(json: unknown): GroupFileRead {
  const read = readStruct(json, GroupDef, 'group');
  if (read.value === undefined) return { diagnostics: read.diagnostics };

  restampDeclared(read.value.subgraph);
  return { def: read.value, diagnostics: read.diagnostics };
}

/**
 * Puts each node's declared row metadata back after a read. nstructjs serializes a property
 * whole, so a graph written before a name, a description or a flag was declared loads carrying
 * the empty ones the file holds and draws rows with no tooltip. What an author set is the value
 * and `wasSet`; everything the editor reads to draw the row belongs to the node type.
 */
function restampDeclared(graph: Graph): void {
  for (const node of graph.nodes) {
    const def = node.def;

    for (const key of Object.keys(def.props ?? {})) {
      stamp(def.props?.[key], node.props[key]);
    }
    for (const key of Object.keys(def.inputs ?? {})) {
      stamp(def.inputs?.[key]?.defaultProp, node.inputs[key]?.defaultProp);
    }
  }
}

function stamp(declared: ToolProperty | undefined, loaded: ToolProperty | undefined): void {
  if (declared === undefined || loaded === undefined) return;

  loaded.uiname = declared.uiname;
  loaded.description = declared.description;
  loaded.flag = declared.flag;
}

export interface GroupFileRead {
  /** Absent whenever the diagnostics list is non-empty. */
  def?: GroupDef;
  diagnostics: GraphFileDiagnostic[];
}

interface StructRead<T> {
  value?: T;
  diagnostics: GraphFileDiagnostic[];
}

/** Validates against a STRUCT layout, then deserializes, reporting rather than throwing. */
function readStruct<T extends StructableInstance>(
  json: unknown,
  cls: StructableClass<T>,
  what: FileKind,
): StructRead<T> {
  const details: string[] = [];
  const collect = (...args: unknown[]): void => {
    details.push(args.map((a) => String(a)).join(' '));
  };

  let valid = false;
  try {
    valid = validateJSON(json, cls, true, false, collect);
  } catch (err) {
    collect(err instanceof Error ? err.message : String(err));
  }

  if (!valid) {
    return {
      diagnostics: [{ code: 'malformed-graph-file', message: describe(details, what) }],
    };
  }

  try {
    return { value: readJSON<T>(json, cls), diagnostics: [] };
  } catch (err) {
    return {
      diagnostics: [
        {
          code: 'unreadable-graph-file',
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}

function describe(details: string[], what: FileKind): string {
  const text = details.join('; ').trim();
  return text === '' ? `the file does not match the ${what} layout` : text;
}
