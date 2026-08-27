/**
 * The built-in node types. Each class declares sockets, props and the metadata the
 * registry carries beside them; the work each one does is registered separately, in
 * `runtimes.ts`, so a host that only reads or edits a graph never loads it.
 */
import { Node } from 'pathux-graph';
import type { NodeDef, Sockets } from 'pathux-graph';
import { BoolProperty, PropFlags, StringProperty } from 'pathux-toolprop';

import { mtok } from '../prices.js';
import { registerGenNode, type NodeMigration } from '../registry.js';
import { ImageSocket, RefsSocket, TextSocket } from './sockets.js';

/**
 * What one text call is estimated at. A node's estimate runs before anything has a value,
 * so the length of the prompt an author will actually send is not knowable here.
 */
const NOMINAL_IN_TOKENS = 1_000;
const NOMINAL_OUT_TOKENS = 500;

/**
 * A string prop, named and described for the row path.ux draws it as. `NO_UNDO` keeps the
 * write off path.ux's own toolstack, because a graph is edited through `gengraph.*` commands
 * and the application's undo stack is the one that holds them.
 */
function str(value: string, uiname: string, description: string): StringProperty {
  return new StringProperty(value, undefined, uiname, description, PropFlags.NO_UNDO);
}

/** A boolean prop, on the same terms as `str`. */
function bool(value: boolean, uiname: string, description: string): BoolProperty {
  return new BoolProperty(value, undefined, uiname, description, PropFlags.NO_UNDO);
}

/** The prompt the host derived for the bound slot, passed through unchanged. */
export class GenDerivedPrompt extends Node<{ prompt: TextSocket }, { prompt: TextSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenDerivedPrompt',
      uiName: 'Derived prompt',
      description: 'Carries the prompt the host derived for the slot this graph is bound to.',
      inputs: {
        prompt: new TextSocket('in', 'Prompt', 'The prompt the host seeds this graph with.'),
      },
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
      inputs: {
        assets: new TextSocket(
          'in',
          'Assets',
          'The reference pictures the host seeds, as a JSON list of assets.',
        ),
      },
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
      props: {
        slot: str('', 'Slot', 'Which slot to read the current asset of, such as plate:garden.'),
      },
      typeVersion: 1,
    };
  }
}

/**
 * Authored text, with `{varA}`, `{varB}` and `{varC}` replaced by whatever feeds those inputs. A
 * template naming no placeholder is a plain text node.
 */
export class GenTemplate extends Node<
  { varA: TextSocket; varB: TextSocket; varC: TextSocket },
  { text: TextSocket }
> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenTemplate',
      uiName: 'Text',
      description:
        'Authored text, with {varA}, {varB} and {varC} replaced by what feeds those inputs.',
      inputs: {
        varA: new TextSocket('in', 'varA', 'Text that replaces {varA} in the template.'),
        varB: new TextSocket('in', 'varB', 'Text that replaces {varB} in the template.'),
        varC: new TextSocket('in', 'varC', 'Text that replaces {varC} in the template.'),
      },
      outputs: { text: new TextSocket('out') },
      props: {
        template: str(
          '',
          'Template',
          'The text this node passes on, with {varA}, {varB} and {varC} filled in.',
        ),
      },
      typeVersion: 2,
    };
  }
}

/**
 * The template inputs were `a`, `b` and `c` until v2, which read as anonymous beside a `slot` or a
 * `prompt`. The authored template says the same names, so it is rewritten alongside them.
 */
const TEMPLATE_VARS: NodeMigration = {
  to: 2,
  inputs: { a: 'varA', b: 'varB', c: 'varC' },
  placeholders: ['template'],
};

/** Rewrites its input through a text model. */
export class GenRewrite extends Node<{ text: TextSocket }, { text: TextSocket }> {
  static override graphDef(): NodeDef {
    return {
      typeName: 'GenRewrite',
      uiName: 'LLM rewrite',
      description: 'Rewrites the text feeding it through a language model.',
      inputs: { text: new TextSocket('in', 'Text', 'The text to rewrite.') },
      outputs: { text: new TextSocket('out') },
      props: {
        model: str('claude-opus-4-8', 'Model', 'Which language model rewrites the text.'),
        instruction: str('', 'Instruction', 'What to ask the model to do to the text.'),
        system: str('', 'System', 'The system prompt sent ahead of the instruction.'),
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
        prompt: new TextSocket('in', 'Prompt', 'What to draw.'),
        refs: new RefsSocket('in'),
        refine: new TextSocket('in', 'Refine', 'A critique to draw against, from an earlier pass.'),
      },
      outputs: { image: new ImageSocket('out') },
      props: {
        model: str('gemini-2.5-flash-image', 'Model', 'Which image model draws the picture.'),
        aspect: str(
          '',
          'Aspect',
          'The aspect ratio to ask for, such as 16:9. Empty asks for none.',
        ),
        seed: str('', 'Seed', 'The seed to draw with. Empty lets the model pick one.'),
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
        prompt: new TextSocket('in', 'Prompt', 'What to change about the picture.'),
        refs: new RefsSocket('in'),
      },
      outputs: { image: new ImageSocket('out') },
      props: {
        model: str('gemini-2.5-flash-image', 'Model', 'Which image model redraws the picture.'),
        aspect: str(
          '',
          'Aspect',
          'The aspect ratio to ask for, such as 16:9. Empty asks for none.',
        ),
        seed: str('', 'Seed', 'The seed to draw with. Empty lets the model pick one.'),
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
      props: {
        hash: str('', 'Hash', 'The content hash of the picture in the asset store.'),
        ext: str('png', 'Extension', "The stored file's extension, without the dot."),
      },
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
      inputs: {
        text: new TextSocket('in', 'Text', 'The critique a refine pass wrote.'),
      },
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
      props: { useB: bool(false, 'Use b', 'Pass on picture b rather than picture a.') },
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
      props: {
        slot: str('', 'Slot', 'Which slot this graph fills, such as portrait:aiko.'),
        active: bool(
          true,
          'Active',
          'Evaluate this output for its slot, standing down the others claiming it.',
        ),
      },
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
  registerGenNode({ cls: GenTemplate, migrations: [TEMPLATE_VARS] });
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
