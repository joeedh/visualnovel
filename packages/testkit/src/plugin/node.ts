/**
 * The fixture plugin's node type, in its own module so bundling it is actually exercised.
 * Nothing here imports the plugin API for its values: the class is built by a factory the
 * entry module calls with the API it was activated with.
 */
import type { GenNodeSpec, GenPluginApi } from '@vn/gengraph/plugin';

export const TYPE_NAME = 'TestkitShout';

/** What one call of the fixture's model is estimated at, in tokens. */
const NOMINAL_TOKENS = 200;

/**
 * Declares the fixture's node type against the API the host activated the plugin with. The
 * class name matches {@link TYPE_NAME} because the node registry refuses a class whose name
 * and declared type name differ.
 */
export function shoutSpec(api: GenPluginApi): GenNodeSpec {
  class TestkitShout extends api.Node {
    static override graphDef() {
      return {
        typeName   : TYPE_NAME,
        uiName     : 'Shout',
        description: 'Rewrites the text feeding it, louder.',
        inputs     : { text: new api.TextSocket('in') },
        outputs    : { text: new api.TextSocket('out') },
        props      : { model: new api.StringProperty('testkit-shouter') },
        typeVersion: 1,
      };
    }
  }

  return {
    cls     : TestkitShout,
    spends  : true,
    estimate: (props) => [
      {
        service: 'text',
        model  : String(props['model']),
        unit   : 'mtok-in',
        count  : api.mtok(NOMINAL_TOKENS),
      },
    ],
  };
}
