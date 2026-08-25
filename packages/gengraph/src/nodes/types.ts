/**
 * The built-in node types. Each class declares sockets, props and the metadata the
 * registry carries beside them; the work each one does is registered separately, in
 * `runtimes.ts`, so a host that only reads or edits a graph never loads it.
 */
import { Node } from 'pathux-graph';
import type { NodeDef, Sockets } from 'pathux-graph';
import { BoolProperty, StringProperty } from 'pathux-toolprop';

import { mtok } from '../prices.js';
import { registerGenNode } from '../registry.js';
import { ImageSocket, RefsSocket, TextSocket } from './sockets.js';

/**
 * What one text call is estimated at. A node's estimate runs before anything has a value,
 * so the length of the prompt an author will actually send is not knowable here.
 */
const NOMINAL_IN_TOKENS = 1_000;
const NOMINAL_OUT_TOKENS = 500;

/** The prompt the host derived for the bound slot, passed through unchanged. */
export class GenDerivedPrompt extends Node<{ prompt: TextSocket }, { prompt: TextSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenDerivedPrompt',
      uiName: 'Derived prompt',
      description: 'Carries the prompt the host derived for the slot this graph is bound to.',
      inputs: { prompt: new TextSocket('in') },
      outputs: { prompt: new TextSocket('out') },
      typeVersion: 1,
    };
  }
}

/** The task's own reference pictures, seeded by the host as a JSON list of assets. */
export class GenTaskRefs extends Node<{ assets: TextSocket }, { refs: RefsSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenTaskRefs',
      uiName: 'Task refs',
      description: "Carries the reference pictures the host resolved for this graph's task.",
      inputs: { assets: new TextSocket('in') },
      outputs: { refs: new RefsSocket('out') },
      typeVersion: 1,
    };
  }
}

/** Reads whatever asset another slot currently holds. */
export class GenSlotRef extends Node<Sockets, { image: ImageSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenSlotRef',
      uiName: 'Slot ref',
      description: 'Reads the asset another slot holds right now, such as a plate or a sheet.',
      outputs: { image: new ImageSocket('out') },
      props: { slot: new StringProperty('') },
      typeVersion: 1,
    };
  }
}

/**
 * Authored text, with `{a}`, `{b}` and `{c}` replaced by whatever feeds those inputs. A
 * template naming no placeholder is a plain text node.
 */
export class GenTemplate extends Node<
  { a: TextSocket; b: TextSocket; c: TextSocket },
  { text: TextSocket }
> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenTemplate',
      uiName: 'Text',
      description: 'Authored text, with {a}, {b} and {c} replaced by what feeds those inputs.',
      inputs: { a: new TextSocket('in'), b: new TextSocket('in'), c: new TextSocket('in') },
      outputs: { text: new TextSocket('out') },
      props: { template: new StringProperty('') },
      typeVersion: 1,
    };
  }
}

/** Rewrites its input through a text model. */
export class GenRewrite extends Node<{ text: TextSocket }, { text: TextSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenRewrite',
      uiName: 'LLM rewrite',
      description: 'Rewrites the text feeding it through a language model.',
      inputs: { text: new TextSocket('in') },
      outputs: { text: new TextSocket('out') },
      props: {
        model: new StringProperty('claude-opus-4-8'),
        instruction: new StringProperty(''),
        system: new StringProperty(''),
      },
      typeVersion: 1,
    };
  }
}

/** Draws a picture from a prompt and reference pictures. */
export class GenImage extends Node<
  { prompt: TextSocket; refs: RefsSocket; refine: TextSocket },
  { image: ImageSocket }
> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenImage',
      uiName: 'Generate image',
      description: 'Draws a picture from the prompt and references feeding it.',
      inputs: {
        prompt: new TextSocket('in'),
        refs: new RefsSocket('in'),
        refine: new TextSocket('in'),
      },
      outputs: { image: new ImageSocket('out') },
      props: {
        model: new StringProperty('gemini-2.5-flash-image'),
        aspect: new StringProperty(''),
        seed: new StringProperty(''),
      },
      typeVersion: 1,
    };
  }
}

/** Redraws a picture it is given, guided by a prompt and further references. */
export class GenEditImage extends Node<
  { base: ImageSocket; prompt: TextSocket; refs: RefsSocket },
  { image: ImageSocket }
> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenEditImage',
      uiName: 'Edit image',
      description: 'Redraws the picture feeding it, guided by a prompt and further references.',
      inputs: {
        base: new ImageSocket('in'),
        prompt: new TextSocket('in'),
        refs: new RefsSocket('in'),
      },
      outputs: { image: new ImageSocket('out') },
      props: {
        model: new StringProperty('gemini-2.5-flash-image'),
        aspect: new StringProperty(''),
        seed: new StringProperty(''),
      },
      typeVersion: 1,
    };
  }
}

/** Collects pictures into one ordered list, the list input first and then a, b and c. */
export class GenRefList extends Node<
  { list: RefsSocket; a: ImageSocket; b: ImageSocket; c: ImageSocket },
  { refs: RefsSocket }
> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenRefList',
      uiName: 'Reference list',
      description: 'Collects pictures into one list, the list input first and then a, b and c.',
      inputs: {
        list: new RefsSocket('in'),
        a: new ImageSocket('in'),
        b: new ImageSocket('in'),
        c: new ImageSocket('in'),
      },
      outputs: { refs: new RefsSocket('out') },
      typeVersion: 1,
    };
  }
}

/** Names a picture already in the asset store, such as an upload or a concept image. */
export class GenImageFile extends Node<Sockets, { image: ImageSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenImageFile',
      uiName: 'Image file',
      description: 'Names a picture already in the asset store, by content hash.',
      outputs: { image: new ImageSocket('out') },
      props: { hash: new StringProperty(''), ext: new StringProperty('png') },
      typeVersion: 1,
    };
  }
}

/** The critique a refine pass writes, empty until one has run. */
export class GenRefinePrompt extends Node<{ text: TextSocket }, { text: TextSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenRefinePrompt',
      uiName: 'Refine prompt',
      description: 'Carries the critique a refine pass wrote, and is empty until one has run.',
      inputs: { text: new TextSocket('in') },
      outputs: { text: new TextSocket('out') },
      typeVersion: 1,
    };
  }
}

/** Passes on one of two pictures, so a branch can be tried without rewiring the graph. */
export class GenSwitch extends Node<{ a: ImageSocket; b: ImageSocket }, { image: ImageSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenSwitch',
      uiName: 'Switch',
      description: 'Passes on picture a or picture b, so a branch is tried without rewiring.',
      inputs: { a: new ImageSocket('in'), b: new ImageSocket('in') },
      outputs: { image: new ImageSocket('out') },
      props: { useB: new BoolProperty(false) },
      typeVersion: 1,
    };
  }
}

/**
 * The terminal a run is read from. Its `slot` names what the picture fills, and `active`
 * marks which of several outputs on one slot the run evaluates.
 */
export class GenOutput extends Node<{ image: ImageSocket }, Sockets> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenOutput',
      uiName: 'Output image',
      description: 'Fills the named slot with the picture feeding it.',
      inputs: { image: new ImageSocket('in') },
      props: { slot: new StringProperty(''), active: new BoolProperty(true) },
      typeVersion: 1,
    };
  }
}

/**
 * Registers all twelve types and their specs. Safe to call twice, because each
 * registration overwrites the one before it.
 */
export function registerGenNodes(): void {
  registerGenNode({ cls: GenDerivedPrompt, seededInput: 'prompt', refineFallback: true });
  registerGenNode({ cls: GenTaskRefs, seededInput: 'assets' });
  registerGenNode({ cls: GenSlotRef });
  registerGenNode({ cls: GenTemplate });
  registerGenNode({
    cls: GenRewrite,
    spends: true,
    estimate: (props) => [
      {
        service: 'text',
        model: String(props.model),
        unit: 'mtok-in',
        count: mtok(NOMINAL_IN_TOKENS),
      },
      {
        service: 'text',
        model: String(props.model),
        unit: 'mtok-out',
        count: mtok(NOMINAL_OUT_TOKENS),
      },
    ],
  });
  registerGenNode({
    cls: GenImage,
    spends: true,
    refineInput: 'refine',
    estimate: (props) => [
      { service: 'image', model: String(props.model), unit: 'image', count: 1 },
    ],
  });
  registerGenNode({
    cls: GenEditImage,
    spends: true,
    estimate: (props) => [
      { service: 'image', model: String(props.model), unit: 'image', count: 1 },
    ],
  });
  registerGenNode({ cls: GenRefList });
  registerGenNode({ cls: GenImageFile });
  registerGenNode({ cls: GenRefinePrompt, seededInput: 'text' });
  registerGenNode({ cls: GenSwitch });
  registerGenNode({ cls: GenOutput, slotProp: 'slot' });
}
