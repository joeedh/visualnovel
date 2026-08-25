import { readJSON, validateJSON, writeJSON } from 'nstructjs';
import { Graph } from 'pathux-graph';

export type GraphFileDiagnosticCode = 'malformed-graph-file' | 'unreadable-graph-file';

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
  const details: string[] = [];
  const collect = (...args: unknown[]): void => {
    details.push(args.map((a) => String(a)).join(' '));
  };

  let valid = false;
  try {
    valid = validateJSON(json, Graph, true, false, collect);
  } catch (err) {
    collect(err instanceof Error ? err.message : String(err));
  }

  if (!valid) {
    return {
      diagnostics: [{ code: 'malformed-graph-file', message: describe(details) }],
    };
  }

  try {
    return { graph: readJSON<Graph>(json, Graph), diagnostics: [] };
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

function describe(details: string[]): string {
  const text = details.join('; ').trim();
  return text === '' ? 'the file does not match the graph layout' : text;
}
