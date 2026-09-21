/** The sheet form's situations: which controls a sheet's front matter draws, and when they refuse. */
import { situations } from './situation.js';
import type { SheetFormState } from '../sheetform.js';

export const SITUATIONS = situations<SheetFormState>(
  {
    name : 'palette',
    why  : 'A character sheet with two swatches offers each, its ✕, and the slot that adds one.',
    state: { path: 'characters/aiko/character.md', palette: { swatches: 2 } },
  },
  {
    name : 'palette-empty',
    why  : 'A sheet whose palette is empty offers only the slot that adds a swatch.',
    state: { path: 'characters/aiko/character.md', palette: { swatches: 0 } },
  },
  {
    name : 'wardrobe',
    why: "A wardrobe of two outfits offers each row's boxes, the default mark on one and the sheet drawn for the other, and the button that adds a row.",
    state: {
      path    : 'characters/aiko/character.md',
      wardrobe: {
        ids    : ['uniform', 'gala'],
        default: 'uniform',
        art    : [{ id: 'gala', asset: { hash: 'a1b2c3', label: 'gala / side', accepted: false } }],
        visible: ['wiki'],
      },
    },
  },
  {
    name : 'variants',
    why: "A location's two variants offer each row's boxes with no default mark, the plate drawn for one, and the button that adds a row.",
    state: {
      path    : 'locations/cafe.md',
      variants: {
        ids    : ['day', 'night'],
        art: [{ id: 'night', asset: { hash: 'b2c3d4', label: 'cafe / night', accepted: true } }],
        visible: ['wiki', 'asset'],
      },
    },
  },
  {
    name : 'prompt',
    why: "A character with a drawn portrait and a saved sheet offers the button to the portrait's prompt.",
    state: {
      path  : 'characters/aiko/character.md',
      prompt: { hash: 'c3d4e5', visible: ['wiki'] },
    },
  },
  {
    name : 'prompt-dirty',
    why: 'The button refuses while the sheet has unsaved edits, which the Asset editor would overtake.',
    state: {
      path  : 'characters/aiko/character.md',
      prompt: { hash: 'c3d4e5', dirty: true, visible: ['wiki'] },
    },
  },
  {
    name : 'prompt-undrawn',
    why  : 'With no portrait drawn there is no prompt to edit, and the button says so.',
    state: { path: 'characters/aiko/character.md', prompt: {} },
  },
  {
    name : 'wardrobe-empty',
    why  : 'A sheet with no outfits offers only the button that adds one.',
    state: { path: 'characters/aiko/character.md', wardrobe: { ids: [] } },
  },
  {
    name : 'model',
    why: "Every sheet carries an image-model menu, whose pick is the same write as the sheet's boxes.",
    state: { path: 'characters/aiko/character.md', model: true },
  },
  {
    name : 'read-only',
    why  : 'A session that refuses writes greys every control of the form with the reason.',
    state: {
      path    : 'characters/aiko/character.md',
      readOnly: true,
      palette : { swatches: 1 },
      wardrobe: { ids: ['uniform'], default: 'uniform' },
      model   : true,
    },
  },
);
