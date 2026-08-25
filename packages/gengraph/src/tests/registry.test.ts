import { StringProperty } from 'pathux-toolprop';

import {
  Node,
  genNodeRuntime,
  genNodeSpec,
  genNodeTypes,
  getNodeClass,
  registerGenNode,
  registerGenRuntime,
} from '../index.js';
import type { GenNodeRun, NodeDef } from '../index.js';
import { TestOutput, TestSource, registerTestNodes } from './__fixtures__/nodes.js';

registerTestNodes();

describe('the node registry', () => {
  it('records a spec beside the class path.ux registered', () => {
    expect(getNodeClass('TestSource')).toBe(TestSource);
    expect(genNodeSpec('TestSource')).toEqual({ cls: TestSource });

    expect(genNodeSpec('TestOutput')).toEqual({
      cls: TestOutput,
      spends: true,
      slotProp: 'slot',
    });
    expect(genNodeTypes().get('TestOutput')).toBe(TestOutput);
  });

  it('answers nothing for a type name that was never registered', () => {
    expect(genNodeSpec('NotRegistered')).toBeUndefined();
    expect(genNodeTypes().has('NotRegistered')).toBe(false);
  });

  it('refuses a slotProp that names no prop on the type', () => {
    class MisdeclaredSlot extends Node {
      static override graphDef(): NodeDef {
        return { typeName: 'MisdeclaredSlot', props: { slot: new StringProperty('') } };
      }
    }

    expect(() => registerGenNode({ cls: MisdeclaredSlot, slotProp: 'slotKey' })).toThrow(
      /slotProp 'slotKey' names no prop/,
    );
  });

  it('binds a runtime to a registered type and refuses an unregistered one', () => {
    const run: GenNodeRun = () => Promise.resolve({ blob: 'abc' });
    registerGenRuntime('TestSource', run);

    expect(genNodeRuntime('TestSource')).toBe(run);
    expect(genNodeRuntime('TestOutput')).toBeUndefined();
    expect(() => registerGenRuntime('NotRegistered', run)).toThrow(
      /no gen node type 'NotRegistered' is registered/,
    );
  });
});
