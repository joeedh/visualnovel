/**
 * The one node type this plugin declares, built by a factory the entry module calls with the
 * API it was activated with, because a plugin imports the API for types only.
 */
import type {
  GenCostLine,
  GenNodeSpec,
  GenPluginApi,
  GenProps,
  NodeDef,
} from '@vn/gengraph/plugin';

export const GENERATE_TYPE = 'OpenRouterImage';

/**
 * The model the node starts on. OpenRouter names a model as `<vendor>/<model>`, and Google's
 * image models are the ones its listing is known to carry.
 */
export const DEFAULT_MODEL = 'google/gemini-2.5-flash-image';

/**
 * One image call. OpenRouter prices a model however its provider does, per image or per
 * token, so the line names the model and leaves the price to whichever table knows it.
 */
function oneImage(props: GenProps): GenCostLine[] {
  return [{ service: 'image', model: String(props['model']), unit: 'image', count: 1 }];
}

export function generateSpec(api: GenPluginApi): GenNodeSpec {
  class OpenRouterImage extends api.Node {
    static override graphDef(): NodeDef {
      return {
        typeName   : GENERATE_TYPE,
        uiName     : 'OpenRouter image',
        description:
          'Draws a picture with the OpenRouter model named on the node from the prompt and ' +
          'references feeding it.',
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

  return { cls: OpenRouterImage, spends: true, refineInput: 'refine', estimate: oneImage };
}
