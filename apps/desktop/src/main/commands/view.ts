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
