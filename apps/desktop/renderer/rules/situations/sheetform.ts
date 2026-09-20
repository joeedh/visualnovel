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
    name : 'wardrobe-empty',
    why  : 'A sheet with no outfits offers only the button that adds one.',
    state: { path: 'characters/aiko/character.md', wardrobe: { ids: [] } },
  },
  {
    name : 'read-only',
    why  : 'A session that refuses writes greys every control of the form with the reason.',
    state: {
      path    : 'characters/aiko/character.md',
      readOnly: true,
      palette : { swatches: 1 },
      wardrobe: { ids: ['uniform'], default: 'uniform' },
    },
  },
);
