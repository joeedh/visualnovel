/**
 * Two node types and a socket type the graph tests build graphs out of. The socket
 * type is deliberately not one of path.ux's own: float and vec3 coerce to each other,
 * and a link the validator must refuse needs a type that coerces to nothing.
 */
import { StringProperty } from 'pathux-toolprop';

import {
  FloatSocket,
  Node,
  NodeSocketBase,
  registerGenNode,
  registerSocketType,
} from '../../index.js';
import type { NodeDef, Sockets, SocketTypeDef } from '../../index.js';

export class TestBlobSocket extends NodeSocketBase<'blob', string> {
  static override socketDef(): SocketTypeDef {
    return { typeName: 'TestBlobSocket', type: 'blob', uiName: 'Blob' };
  }
}
registerSocketType(TestBlobSocket);

export class TestSource extends Node<Sockets, { blob: TestBlobSocket; amount: FloatSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'TestSource',
      outputs: { blob: new TestBlobSocket('out'), amount: new FloatSocket('out') },
      props: { label: new StringProperty('') },
    };
  }
}

export class TestOutput extends Node<{ image: TestBlobSocket }, Sockets> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'TestOutput',
      inputs: { image: new TestBlobSocket('in') },
      props: { slot: new StringProperty('') },
    };
  }
}

/** Registers both types. Safe to call twice; the second call overwrites the first. */
export function registerTestNodes(): void {
  registerGenNode({ cls: TestSource });
  registerGenNode({ cls: TestOutput, spends: true, slotProp: 'slot' });
}

export function setProp(node: Node, key: string, value: unknown): void {
  const prop = node.props[key];
  if (prop === undefined) {
    throw new Error(`${node.def.typeName} has no prop '${key}'`);
  }
  prop.setValue(value);
}

export function propValue(node: Node, key: string): unknown {
  return node.props[key]?.getValue();
}
