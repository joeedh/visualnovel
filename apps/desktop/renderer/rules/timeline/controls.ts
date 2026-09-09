/**
 * What the timeline's bar and its undecomposed note offer: the hand-placed shot, and the two doors
 * out of a scene with no shots. A door is drawn before its `command:check` answers and anchored
 * only once it has, so its verdict reaches this module as state rather than as a promise.
 */
import type { CommandCheck, PropValue } from '../../../src/shared/ipc.js';
import { keyOf, refuse, type Control, type Offer } from '../anchors.js';
import {
  addCastAction,
  removeCastAction,
  requireCastAction,
  variantAction,
  type ShotCast,
} from './cast.js';
import { outfitAction, type OutfitRow } from './wardrobe.js';

/** A door: a control together with the props the dialog opens on, before its verdict is known. */
export interface Door extends Control {
  props: Record<string, PropValue>;
}

/** What the timeline reads when it draws its bar and its doors. */
export interface TimelineState {
  /** The scene on screen, or the empty string with none. */
  sceneId: string;
  /** Present while the scene on screen has no shots yet. */
  undecomposed?: { sceneId: string; firstLine: string };
  /** Each door's verdict, keyed by {@link doorKey}, cleared when the doors are re-asked. */
  verdicts: Record<string, CommandCheck>;
  /** The wardrobe strip's rows, scene level first, as `outfitRows` lists them. */
  wardrobe?: readonly OutfitRow[];
  /** The selected shot's cast, while a shot is selected. */
  cast?: ShotCast | null;
}

/**
 * Place a shot by hand. A scene whose every line is covered still takes one, which claims its
 * lines off the shots that hold them, so this is the door for a scene the gutter drag cannot
 * reach. Opens the command's own form, priced before it runs.
 */
export function addShotAction(sceneId: string): Offer {
  const control = {
    id     : 'story.newShot',
    label  : '+ shot',
    tooltip:
      'Place a shot by hand over lines you name — a new frame to render. Opens the command, priced before it runs.',
    form   : true,
  };
  if (sceneId === '') return { ...refuse('No scene is on screen.'), ...control };
  return { ok: true, props: { scene: sceneId }, ...control };
}

/** The door that has the writing model storyboard every undecomposed scene. */
export function decomposeDoor(): Door {
  return {
    id     : 'story.decomposeAll',
    props  : {},
    label  : 'decompose',
    tooltip:
      'Ask the writing model to storyboard every scene that has none — one model call per scene, priced in the dialog before it runs.',
    form   : true,
  };
}

/**
 * The door that places the scene's first shot by hand, which ends decomposition for it. Carries
 * `on`, because the bar's `+ shot` runs the same command in the same pane.
 */
export function byHandDoor(sceneId: string, firstLine: string): Door {
  return {
    id     : 'story.newShot',
    props  : { scene: sceneId, lines: firstLine },
    on     : 'undecomposed',
    label  : 'place a shot by hand',
    tooltip: `Create the storyboard for ${sceneId} yourself, one shot at a time — which ends decomposition for this scene.`,
    form   : true,
  };
}

/** Where a door's verdict is kept: the scene it was asked about, then the door's anchor key. */
export const doorKey = (sceneId: string, door: Door): string => `${sceneId}/${keyOf(door)}`;

/** A door once its verdict is in: greyed with the command's own sentence when refused. */
export function doorAction(door: Door, check: CommandCheck): Offer {
  const { props, ...control } = door;
  if (check.state === 'refuse') return { ...refuse(check.message), ...control };
  return { ok: true, props, ...control };
}

/**
 * The wardrobe strip's offers in draw order: the scene rows, then the selected shot's variant,
 * its rows with their remove buttons, the add select while someone is left to add, and the
 * checkbox.
 */
export function wardrobeControls(rows: readonly OutfitRow[], cast: ShotCast | null): Offer[] {
  if (rows.length === 0) return [];
  const list: Offer[] = rows.filter((row) => row.level === 'scene').map(outfitAction);
  if (!cast) return list;
  list.push(variantAction(cast));
  for (const row of rows.filter((row) => row.level === 'shot')) {
    list.push(outfitAction(row), removeCastAction(cast, row.character));
  }
  if (cast.spare.length > 0) list.push(addCastAction(cast));
  list.push(requireCastAction(cast));
  return list;
}

/**
 * Every offer the timeline draws from this module: the add button, each answered door, then the
 * wardrobe strip.
 */
export function controls(state: TimelineState): readonly Offer[] {
  const list: Offer[] = [addShotAction(state.sceneId)];
  const scene = state.undecomposed;
  if (scene) {
    for (const door of [decomposeDoor(), byHandDoor(scene.sceneId, scene.firstLine)]) {
      const check = state.verdicts[doorKey(scene.sceneId, door)];
      if (check) list.push(doorAction(door, check));
    }
  }
  list.push(...wardrobeControls(state.wardrobe ?? [], state.cast ?? null));
  return list;
}
