/**
 * A plugin that installs and runs, kept here so the loader is tested against sources that
 * are typechecked and linted like the rest of the repository rather than written into a
 * temporary directory by a test.
 */
import type { GenPluginApi } from '@vn/gengraph/plugin';

import { shoutSpec, TYPE_NAME } from './node.js';

export default function activate(api: GenPluginApi): void {
  api.registerNode(shoutSpec(api));
  api.registerRuntime(TYPE_NAME, async (inputs, props, services) => {
    const said = await services.text.complete(String(props['model']), String(inputs['text'] ?? ''));
    return { text: said };
  });
}
