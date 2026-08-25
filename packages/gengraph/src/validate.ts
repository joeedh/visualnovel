import { parseSlot } from '@vn/artgen';
import type { Graph, GraphId, Node } from 'pathux-graph';

import { genNodeSpec } from './registry.js';

export type GenDiagnosticCode =
  | 'unknown-node-type'
  | 'unknown-prop'
  | 'orphaned-socket'
  | 'link-type-mismatch'
  | 'slot-unparsed'
  | 'slot-is-asset';

export interface GenDiagnostic {
  code: GenDiagnosticCode;
  message: string;
  nodeId: GraphId;
}

/**
 * Checks a loaded graph against the registry: node types, props and sockets that the
 * type declares, links whose ends can coerce, and the slot an output node names. A
 * graph naming no slot is legal, because an author builds one before binding it.
 */
export function validateGenGraph(graph: Graph): GenDiagnostic[] {
  const out: GenDiagnostic[] = [];
  const report = (code: GenDiagnosticCode, node: Node, message: string): void => {
    out.push({ code, message, nodeId: node.id });
  };

  for (const node of graph.nodes) {
    const typeName = node.def.typeName;
    const spec = genNodeSpec(typeName);

    if (spec === undefined) {
      report(
        'unknown-node-type',
        node,
        `node type '${typeName}' is not registered here; the plugin providing it may not be installed`,
      );
    } else {
      const declared = node.def.props ?? {};
      for (const key of Object.keys(node.props)) {
        if (!(key in declared)) {
          report('unknown-prop', node, `node type '${typeName}' declares no prop '${key}'`);
        }
      }
      checkSlot(node, spec.slotProp, report);
    }

    for (const [key, sock] of Object.entries(node.inputs)) {
      if (sock.orphaned) {
        report('orphaned-socket', node, `node type '${typeName}' declares no input '${key}'`);
        continue;
      }
      for (const src of sock.edges) {
        if (!sock.coerce(src, { dryRun: true })) {
          report(
            'link-type-mismatch',
            node,
            `a '${src.type}' output cannot feed the '${sock.type}' input '${key}'`,
          );
        }
      }
    }

    for (const [key, sock] of Object.entries(node.outputs)) {
      if (sock.orphaned) {
        report('orphaned-socket', node, `node type '${typeName}' declares no output '${key}'`);
      }
    }
  }

  return out;
}

function checkSlot(
  node: Node,
  slotProp: string | undefined,
  report: (code: GenDiagnosticCode, node: Node, message: string) => void,
): void {
  if (slotProp === undefined) {
    return;
  }

  const raw = node.props[slotProp]?.getValue();
  const said = typeof raw === 'string' ? raw.trim() : '';

  // An empty slot is how an unbound graph is authored, so it is not a diagnostic.
  if (said === '') {
    return;
  }

  const binding = parseSlot(said);
  if (binding === undefined) {
    report('slot-unparsed', node, `'${said}' is not a slot address`);
    return;
  }
  if (binding.kind === 'asset') {
    report(
      'slot-is-asset',
      node,
      `'${said}' addresses an asset rather than a slot, and an asset is fixed content that nothing can fill`,
    );
  }
}
