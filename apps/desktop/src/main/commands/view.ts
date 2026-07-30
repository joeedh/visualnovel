/**
 * UI state as commands. These run in main like every other command and push an effect the
 * renderer applies, so the palette, the menu bar and CDP all reach the same vocabulary
 * rather than the renderer maintaining a second registry to keep in sync.
 */
import { defineFor, prop } from '@vn/commands';
import type { FloorMode, StudioMode } from '../../shared/ipc.js';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const viewRoom = define({
  id: 'view.room',
  title: 'Switch room',
  description: 'Show one of the three rooms: STUDIO, FLOOR or PLAY.',
  mutating: false,
  props: { name: prop.oneOf(['studio', 'floor', 'play'] as const, 'the room to show') },
  run({ name }, ctx) {
    ctx.host.ui({ type: 'room', name });
    return Promise.resolve({ message: `Showing the ${name} room.` });
  },
});

/** What each mode shows, and — by which map it appears in — which room it belongs to. */
const STUDIO_MODES = {
  convo: 'the conversation',
  branches: 'the branch editor',
  script: 'the script editor',
} as const;
const FLOOR_MODES = {
  list: 'the task list',
  graph: 'the task graph',
  timeline: 'the coverage timeline',
} as const;

type AnyMode = StudioMode | FloorMode;
const isStudioMode = (mode: AnyMode): mode is StudioMode => mode in STUDIO_MODES;
const isFloorMode = (mode: AnyMode): mode is FloorMode => mode in FLOOR_MODES;

export const viewMode = define({
  id: 'view.mode',
  title: "Switch a room's mode",
  description:
    "Switch STUDIO's main column (convo | branches | script) or FLOOR's " +
    '(list | graph | timeline). PLAY has no modes.',
  mutating: false,
  props: {
    room: prop.oneOf(['studio', 'floor'] as const, 'the room whose mode changes'),
    mode: prop.oneOf(
      ['convo', 'branches', 'script', 'list', 'graph', 'timeline'] as const,
      'the surface to show; must be one the room has',
    ),
  },
  // The props layer can only say "one of these four"; which four belong to *this* room is a
  // pairing, so it is checked here — and a throw is how a command refuses.
  run({ room, mode }, ctx) {
    if (room === 'studio') {
      if (!isStudioMode(mode)) throw new Error(modeError(room, mode, STUDIO_MODES));
      ctx.host.ui({ type: 'mode', room, mode });
      return Promise.resolve({ message: `Showing ${STUDIO_MODES[mode]}.` });
    }
    if (!isFloorMode(mode)) throw new Error(modeError(room, mode, FLOOR_MODES));
    ctx.host.ui({ type: 'mode', room, mode });
    return Promise.resolve({ message: `Showing ${FLOOR_MODES[mode]}.` });
  },
});

const modeError = (room: string, mode: string, modes: Record<string, string>): string =>
  `${room.toUpperCase()} has no "${mode}" mode — try ${Object.keys(modes).join(' or ')}.`;

export const viewPanelSize = define({
  id: 'view.panelSize',
  title: 'Resize a panel',
  description: 'Set the saved width of a resizable panel (studio.rail, floor.inspector).',
  mutating: false,
  props: {
    id: prop.string("the panel's save id, e.g. studio.rail"),
    width: prop.number('width in pixels', { min: 80, max: 1200 }),
  },
  run({ id, width }, ctx) {
    // No `UiEffect` needed: the session store broadcasts its own change, which is what the
    // renderer's `usePanelWidth` is already listening for.
    ctx.host.state.set(`panel.${id}.width`, width);
    return Promise.resolve({ message: `Panel ${id} is now ${width}px wide.` });
  },
});

export const viewPalette = define({
  id: 'view.palette',
  title: 'Toggle palette',
  description: 'Open or close the command palette.',
  mutating: false,
  props: { open: prop.boolean('true to open, false to close', { default: true }) },
  run({ open }, ctx) {
    ctx.host.ui({ type: 'palette', open });
    return Promise.resolve({ message: open ? 'Palette opened.' : 'Palette closed.' });
  },
});
