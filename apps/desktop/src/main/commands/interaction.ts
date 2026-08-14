/**
 * The gesture surface, as commands: what interactions exist, and which targets would take one.
 *
 * `interaction.targets` is the point of the whole layer — it answers "what would happen if I
 * dropped this there, and why not" *before* anything is attempted, using the same `targets`
 * the branch editor runs mid-drag. Both are non-mutating: an interaction never writes, it only
 * names the command that would.
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
        'or a line id for script.moveLine',
    ),
    scene: prop.string('which scene, for a gesture judged against one scene', { default: '' }),
  },
  async run({ interaction, carried, scene }, ctx) {
    const gesture = desktopInteractions.get(interaction);
    if (!gesture) throw new Error(`No interaction "${interaction}".`);

    // Each gesture is judged against the state its surface holds, so the state is built per
    // namespace rather than there being one union every interaction has to accept.
    const verdicts = gesture.targets(await stateFor(interaction, scene, ctx.host), carried);
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
 */
async function stateFor(interaction: string, scene: string, host: CommandHost): Promise<unknown> {
  if (interaction.startsWith('script.')) return host.session.scriptState();
  if (!interaction.startsWith('timeline.')) return branchState(await host.session.storyGraph());
  if (!scene) throw new Error(`"${interaction}" is judged against one scene — pass scene=<id>.`);
  const { sceneId, lines, shots } = await host.session.sceneCoverage(scene);
  return { sceneId, lines, shots };
}
