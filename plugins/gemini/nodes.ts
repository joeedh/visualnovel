/**
 * The two node types this plugin declares. Each is built by a factory the entry module calls
 * with the API it was activated with, because a plugin imports the API for types only.
 */
import type {
  GenCostLine,
  GenNodeSpec,
  GenPluginApi,
  GenProps,
  NodeDef,
} from '@vn/gengraph/plugin';

export const GENERATE_TYPE = 'GeminiImage';
export const EDIT_TYPE = 'GeminiEditImage';

/** The model both nodes start on, which is the one this plugin's price fragment covers. */
export const DEFAULT_MODEL = 'gemini-2.5-flash-image';

/** One image call, whichever of the two nodes made it. */
function oneImage(props: GenProps): GenCostLine[] {
  return [{ service: 'image', model: String(props['model']), unit: 'image', count: 1 }];
}

export function generateSpec(api: GenPluginApi): GenNodeSpec {
  class GeminiImage extends api.Node {
    static override graphDef(): NodeDef {
      return {
        typeName   : GENERATE_TYPE,
        uiName     : 'Gemini image',
        description: 'Draws a picture with Gemini from the prompt and references feeding it.',
        inputs: {
          prompt: new api.TextSocket('in'),
          refs  : new api.RefsSocket('in'),
          refine: new api.TextSocket('in'),
        },
        outputs    : { image: new api.ImageSocket('out') },
        props: {
          model : new api.StringProperty(DEFAULT_MODEL),
          aspect: new api.StringProperty(''),
          seed  : new api.StringProperty(''),
        },
        typeVersion: 1,
      };
    }
  }

  return { cls: GeminiImage, spends: true, refineInput: 'refine', estimate: oneImage };
}

export function editSpec(api: GenPluginApi): GenNodeSpec {
  class GeminiEditImage extends api.Node {
    static override graphDef(): NodeDef {
      return {
        typeName   : EDIT_TYPE,
        uiName     : 'Gemini edit image',
        description: 'Redraws the picture feeding it with Gemini, guided by a prompt.',
        inputs: {
          base  : new api.ImageSocket('in'),
          prompt: new api.TextSocket('in'),
          refs  : new api.RefsSocket('in'),
        },
        outputs    : { image: new api.ImageSocket('out') },
        props: {
          model : new api.StringProperty(DEFAULT_MODEL),
          aspect: new api.StringProperty(''),
          seed  : new api.StringProperty(''),
        },
        typeVersion: 1,
      };
    }
  }

  return { cls: GeminiEditImage, spends: true, estimate: oneImage };
}
