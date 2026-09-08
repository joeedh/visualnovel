/**
 * The header menus' situations: a fresh install, a project with history, a run in flight, and a
 * window with nothing to move or save.
 */
import { situations } from './situation.js';
import type { HeaderMenuState } from '../headermenus.js';
import { BUSY_RUN } from '../../../src/shared/ipc.js';
import type { LayoutSummary } from '../../../src/shared/layouts.js';

const LAYOUTS: readonly LayoutSummary[] = [
  {
    slug       : 'writing',
    title      : 'Writing',
    description: 'the script beside the tree, the conversation below',
    source     : 'shipped',
    fingerprint: 'f1',
  },
  {
    slug       : 'review',
    title      : 'Review',
    description: 'the asset editor across the top',
    source     : 'saved',
    fingerprint: 'f2',
    problem    : 'it names an editor this build does not have',
  },
];

const fresh: HeaderMenuState = {
  busyWhat      : '',
  live          : true,
  agentMode     : 'plan',
  recents       : [],
  current       : '',
  layouts       : [],
  activeSlug    : '',
  layout        : '{"vnstudio":"layout/1"}',
  pagesInstalled: false,
  activeEditor  : 'script',
};

export const SITUATIONS = situations<HeaderMenuState>(
  {
    name : 'fresh',
    why: 'Nothing has been opened before and no layout is saved, so Recent and Layout each hold one refused row.',
    state: fresh,
  },
  {
    name : 'project',
    why: 'Two projects are remembered, one of them open and refused; two layouts exist, one unusable; the page builder is installed; the agent is executing.',
    state: {
      ...fresh,
      agentMode     : 'execute',
      recents       : ['C:/stories/transfer', 'C:/stories/harbour'],
      current       : 'C:/stories/transfer',
      layouts       : LAYOUTS,
      activeSlug    : 'writing',
      pagesInstalled: true,
      activeEditor  : 'gengraph',
    },
  },
  {
    name : 'running',
    why  : 'A pipeline run is in flight, so Run Pipeline is refused with the header’s sentence.',
    state: { ...fresh, busyWhat: BUSY_RUN },
  },
  {
    name : 'no-pane',
    why: 'No pane can be moved and the arrangement cannot be serialized, so both rows are refused.',
    state: { ...fresh, activeEditor: '', layout: '' },
  },
);
