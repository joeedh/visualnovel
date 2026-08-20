/**
 * Commands over the gesture surface: which interactions exist, and which targets would take one.
 *
 * `interaction.targets` answers what would happen if a carried thing were dropped on a target,
 * and why a target refuses, before anything is attempted, using the same `targets` the branch
 * editor runs mid-drag. Both commands are non-mutating, because an interaction never writes; it
 * only names the command that would.
 */
import { defineFor, formatVerdicts, prop, toInteractionCatalog } from '@vn/commands';
import {
  branchState,
  createDesktopInteractions,
  INTERACTION_IDS,
} from '../../shared/interactions.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** The registry, also projected and verified against the commands by the catalog entry. */
export const desktopInteractions = createDesktopInteractions();

export const interactionList = define({
  id: 'interaction.list',
  title: 'List interactions',
  description:
    'The direct-manipulation gestures the app offers: what each one carries, what it accepts, ' +
    'and the commands it can commit.',
  mutating: false,
  props: {},
  async run() {
    const entries = toInteractionCatalog(desktopInteractions);
    return { message: `${entries.length} interaction(s).`, data: entries };
  },
});

export const interactionTargets = define({
  id: 'interaction.targets',
  title: 'Judge an interaction’s targets',
  description:
    'Every target of a gesture, each marked accept or refuse with the reason the command ' +
    'itself would give. Reads the live story graph; changes nothing.',
  mutating: false,
  props: {
    interaction: prop.oneOf(INTERACTION_IDS, 'which gesture to judge'),
    carried: prop.string(
      'what is being carried — a scene id, an edge id for branch.unwire, a ' +
        '`<shotId>#start`/`#end` handle for timeline.cover, a shot id for timeline.reorder, ' +
        'a line id for script.moveLine, or a chunk key for prompt.reorder',
    ),
    scene: prop.string('which scene, for a gesture judged against one scene', { default: '' }),
    asset: prop.string('which asset, for prompt.reorder', { default: '' }),
  },
  async run({ interaction, carried, scene, asset }, ctx) {
    const gesture = desktopInteractions.get(interaction);
    if (!gesture) throw new Error(`No interaction "${interaction}".`);

    // Each gesture is judged against the state its surface holds, so the state is built per
    // namespace rather than there being one union every interaction has to accept.
    const verdicts = gesture.targets(await stateFor(interaction, scene, asset, ctx.host), carried);
    const accepted = verdicts.filter((v) => v.accept).length;
    const summary = `${accepted} of ${verdicts.length} target(s) would accept ${carried}.`;
    return {
      message: verdicts.length > 0 ? `${summary}\n${formatVerdicts(verdicts)}` : summary,
      data: verdicts,
    };
  },
});

/**
 * The state a gesture's namespace is judged against. `script.*` takes no `scene` prop: a line id
 * names its own scene, so passing one would be a second answer to the same question.
 *
 * `prompt.*` is judged against one asset's chunks in effective order, which is what
 * `promptView` returns — so the state carries no `order` of its own and a move computes the whole
 * order from what is on screen, exactly as the pane does.
 */
async function stateFor(
  interaction: string,
  scene: string,
  asset: string,
  host: CommandHost,
): Promise<unknown> {
  if (interaction.startsWith('script.')) return host.session.scriptState();
  if (interaction.startsWith('prompt.')) {
    if (!asset)
      throw new Error(`"${interaction}" is judged against one asset — pass asset=<hash>.`);
    const view = await host.session.promptView(asset);
    if (!view) throw new Error(`No asset "${asset}" in the manifest.`);
    return { hash: view.hash, chunks: view.chunks, mode: view.mode };
  }
  if (!interaction.startsWith('timeline.')) return branchState(await host.session.storyGraph());
  if (!scene) throw new Error(`"${interaction}" is judged against one scene — pass scene=<id>.`);
  const { sceneId, lines, shots } = await host.session.sceneCoverage(scene);
  return { sceneId, lines, shots };
}
