/**
 * UI state as commands. These run in main like every other command and push an effect the
 * renderer applies, so the palette, the menu bar and CDP all reach the same vocabulary
 * rather than the renderer maintaining a second registry to keep in sync.
 */
import { defineFor, prop } from '@vn/commands';
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
