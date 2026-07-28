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
  createBranchInteractions,
  INTERACTION_IDS,
} from '../../shared/interactions.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

/** The registry, also projected and verified against the commands by the catalog entry. */
export const desktopInteractions = createBranchInteractions();

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
    carried: prop.string('what is being carried — a scene id, or an edge id for branch.unwire'),
  },
  async run({ interaction, carried }, ctx) {
    const gesture = desktopInteractions.get(interaction);
    if (!gesture) throw new Error(`No interaction "${interaction}".`);

    const verdicts = gesture.targets(branchState(await ctx.host.session.storyGraph()), carried);
    const accepted = verdicts.filter((v) => v.accept).length;
    const summary = `${accepted} of ${verdicts.length} target(s) would accept ${carried}.`;
    return {
      message: verdicts.length > 0 ? `${summary}\n${formatVerdicts(verdicts)}` : summary,
      data: verdicts,
    };
  },
});
