/**
 * Installing, listing and removing generation plugins. A plugin runs with this application's
 * own permissions, so `plugin.install` reads the manifest first and confirms the sentence the
 * manifest itself declares. `confirm: true` is deliberately not used: the framework's gate
 * offers only the command's title, and what an author has to read is which services and keys
 * this particular plugin asked for.
 *
 * Plugins are per-user rather than per-project, so none of these commands touch the workspace
 * and none is undoable. The install replaces whatever was installed under the same name.
 */
import { defineFor, prop } from '@vn/commands';
import {
  activateGenPlugin,
  installGenPlugin,
  pluginDir,
  readGenPlugin,
  readInstalledPlugins,
  removeGenPlugin,
  userPriceFile,
} from '@vn/gengraph/state';
import { pluginBundler } from '../plugins.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

const NAME = 'the plugin, by the name its manifest carries';

export const pluginList = define({
  id: 'plugin.list',
  title: 'List the generation plugins',
  description:
    'Every plugin installed for this user, with what each one declares. A directory that does ' +
    'not read as a plugin carries the reason instead, so a half-installed one is visible.',
  mutating: false,
  props: {},
  async run() {
    const plugins = await readInstalledPlugins();
    const broken = plugins.filter((entry) => entry.reason !== undefined).length;
    const said = broken === 0 ? '' : `, ${broken} of them unreadable`;
    return {
      message: `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}${said}.`,
      data: { plugins },
    };
  },
});

export const pluginInstall = define({
  id: 'plugin.install',
  title: 'Install a generation plugin…',
  description:
    "Copy a plugin directory into this user's plugins folder and activate it, after confirming " +
    "the services and key names it declares. An installed plugin runs with this application's " +
    'own permissions. Installing over a plugin of the same name replaces it.',
  mutating: true,
  undoable: false,
  props: {
    source: prop.string('the plugin directory to install from, or empty to choose one'),
  },
  async check({ source }) {
    if (source.trim().length === 0) return { ok: true, note: 'Opens a directory chooser.' };
    const read = await readGenPlugin(source.trim());
    return read.ok ? { ok: true, note: read.confirmation } : { ok: false, reason: read.reason };
  },
  async run({ source }, ctx) {
    const from =
      source.trim().length > 0
        ? source.trim()
        : await ctx.host.pickDirectory(
            { title: 'Choose a plugin folder', buttonLabel: 'Choose plugin' },
            ctx.origin,
          );
    if (from === undefined) return { message: 'Cancelled.' };

    const read = await readGenPlugin(from);
    if (!read.ok) throw new Error(read.reason);

    if (!ctx.confirm)
      throw new Error('installing a plugin needs confirmation, and no gate is wired');
    if (!(await ctx.confirm(`${read.confirmation} Install it?`))) return { message: 'Cancelled.' };

    const installed = await installGenPlugin(from);
    if (!installed.ok) throw new Error(installed.reason);

    const active = await activateGenPlugin(installed.dir, pluginBundler);
    if (!active.ok) throw new Error(active.reason);

    return {
      message: `Installed ${active.manifest.name} ${active.manifest.version}.`,
      data: { name: active.manifest.name, dir: installed.dir },
    };
  },
});

export const pluginPrices = define({
  id: 'plugin.prices',
  title: 'Refresh what a plugin’s models charge…',
  description:
    'Ask a plugin to look up what its vendor charges and fold the answer into your own price ' +
    'table. It calls a model on your own key, so nothing is looked up until you ask. The ' +
    'models it does not mention keep the prices they already had.',
  mutating: true,
  undoable: false,
  props: {
    name: prop.string(NAME),
  },
  async check({ name }) {
    const installed = await readInstalledPlugins();
    const entry = installed.find((e) => e.name === name);
    if (entry === undefined)
      return { ok: false, reason: `no plugin called "${name}" is installed` };
    if (entry.manifest?.priceAgent !== true) {
      return { ok: false, reason: `${name} does not look up what its models charge` };
    }
    return { ok: true, note: `writes ${userPriceFile()}` };
  },
  async run({ name }, ctx) {
    if (!ctx.confirm) throw new Error('refreshing prices needs confirmation, and no gate is wired');
    const asked = await ctx.confirm(
      `${name} will call a model on your own key to look up what its vendor charges. Do it now?`,
    );
    if (!asked) return { message: 'Cancelled.' };

    const done = await ctx.host.session.refreshPrices(name);
    if (!done.ok) throw new Error(done.reason);

    const count = done.models.length;
    return {
      message: `Priced ${count} model${count === 1 ? '' : 's'} as of ${done.pricesAsOf}.`,
      data: { name, models: done.models, pricesAsOf: done.pricesAsOf },
    };
  },
});

export const pluginRemove = define({
  id: 'plugin.remove',
  title: 'Remove a generation plugin',
  description:
    'Delete an installed plugin and its cached bundle. The node types it declared stay in the ' +
    'registry until the app restarts, and a graph holding one of them then reports the node ' +
    'type as unknown rather than substituting anything.',
  mutating: true,
  undoable: false,
  props: {
    name: prop.string(NAME),
  },
  // Existence rather than readability, because a directory that no longer reads as a plugin is
  // exactly the one an author needs to be able to delete.
  async check({ name }) {
    const installed = await readInstalledPlugins();
    if (!installed.some((entry) => entry.name === name)) {
      return { ok: false, reason: `no plugin called "${name}" is installed` };
    }
    return { ok: true, note: `deletes ${pluginDir(name)}` };
  },
  async run({ name }) {
    const removed = await removeGenPlugin(name);
    if (!removed.ok) throw new Error(removed.reason);
    return { message: `Removed ${name}.`, data: { name, dir: removed.dir } };
  },
});
