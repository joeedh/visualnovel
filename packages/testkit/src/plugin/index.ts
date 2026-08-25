/**
 * A plugin that installs and runs, kept here so the loader is tested against sources that
 * are typechecked and linted like the rest of the repository rather than written into a
 * temporary directory by a test.
 */
import type { GenPluginApi, GenPriceModels } from '@vn/gengraph/plugin';

import { shoutSpec, TYPE_NAME } from './node.js';

/** The model the price agent asks, which is also the one this plugin's node runs against. */
const PRICE_MODEL = 'testkit-shouter';

export default function activate(api: GenPluginApi): void {
  api.registerNode(shoutSpec(api));
  api.registerRuntime(TYPE_NAME, async (inputs, props, services) => {
    const said = await services.text.complete(String(props['model']), String(inputs['text'] ?? ''));
    return { text: said };
  });
  api.registerPriceAgent((services) =>
    services.text.structured<GenPriceModels>(
      PRICE_MODEL,
      'What does the testkit vendor charge per million tokens? Answer with JSON.',
      (raw) => JSON.parse(raw) as GenPriceModels,
    ),
  );
}
