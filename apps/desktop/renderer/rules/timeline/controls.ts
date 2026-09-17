/**
 * What the timeline's bar and its undecomposed note offer: the hand-placed shot, and the two doors
 * out of a scene with no shots. A door is drawn before its `command:check` answers and anchored
 * only once it has, so its verdict reaches this module as state rather than as a promise.
 */
import type { CommandCheck, PropValue } from '../../../src/shared/ipc.js';
import { keyOf, refuse, type Control, type Offer } from '../anchors.js';
import { openMenu, publish, startDrag, view } from '../effects.js';
import {
  addCastAction,
  removeCastAction,
  requireCastAction,
  shotModelAction,
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
  /** The scene's lines, in page order, once the coverage is loaded. */
  lines?: readonly { id: string; text: string }[];
  /** The line whose text box is open, which stands in for that line's control. */
  editing?: string | null;
  /** The shots drawn as brackets beside the lines, in lane order. */
  shots?: readonly { id: string }[];
}

/** The bar's scene picker, a drop-down of every scene in the story. */
export function pickerAction(sceneId: string): Offer {
  return {
    ok: true,
    ...openMenu('scenes'),
    label  : sceneId || 'scene…',
    tooltip: 'Which scene this timeline covers. Every pane follows the choice.',
  };
}

export function reloadAction(): Offer {
  return {
    ok: true,
    ...view('reload'),
    on     : 'reload',
    label  : 'Refresh',
    tooltip: 'Re-read the shots and their images from disk.',
  };
}

/** The gutter at a line's left edge, which sweeps lines into a new shot when dragged along. */
export function gutterAction(line: { id: string }): Offer {
  return {
    ok: true,
    ...startDrag('timeline.create'),
    on     : `line/${line.id}`,
    label  : '',
    tooltip:
      'Drag along this edge to sweep lines into a new shot — a new frame to render, priced as you drag.',
  };
}

/** One line's text, which opens a box to retype it; the new text is what the box supplies. */
export function lineTextAction(line: { id: string; text: string }): Offer {
  return {
    ok      : true,
    id      : 'story.setLineText',
    props   : { line: line.id },
    on      : line.id,
    label   : line.text,
    tooltip : 'Click to retype this line',
    supplies: ['text'],
  };
}

/** The box a line is retyped in, drawn in place of the line while it is open. */
export function lineBox(line: { id: string; text: string }): Offer {
  return {
    ...lineTextAction(line),
    on     : `${line.id}/box`,
    label  : `Retype ${line.id}`,
    tooltip: `Retype ${line.id} — Enter writes it, Escape leaves the line alone`,
  };
}

/** A shot's bracket: a click selects the shot, and a grab that moves reorders it among the others. */
export function bracketAction(shotId: string): Offer {
  return {
    ok: true,
    ...publish({ shotId }),
    on     : `shot/${shotId}`,
    label  : shotId,
    tooltip:
      `${shotId} — click to select it, double-click to open its frame, ` +
      'drag to move it among the other shots',
    then   : [startDrag('timeline.reorder')],
  };
}

/** The handle at a bracket's first or last line, which drags that edge of the shot's coverage. */
export function handleAction(shotId: string, edge: 'start' | 'end'): Offer {
  const which = edge === 'start' ? 'first' : 'last';
  return {
    ok: true,
    ...startDrag('timeline.cover'),
    on     : `shot/${shotId}/${edge}`,
    label  : '',
    tooltip: `Drag to move the ${which} line this shot covers`,
  };
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
 * checkbox. The shot's image-model select sits after the variant, where the strip draws it.
 */
export function wardrobeControls(rows: readonly OutfitRow[], cast: ShotCast | null): Offer[] {
  if (rows.length === 0) return [];
  const list: Offer[] = rows.filter((row) => row.level === 'scene').map(outfitAction);
  if (!cast) return list;
  list.push(variantAction(cast), shotModelAction(cast));
  for (const row of rows.filter((row) => row.level === 'shot')) {
    list.push(outfitAction(row), removeCastAction(cast, row.character));
  }
  if (cast.spare.length > 0) list.push(addCastAction(cast));
  list.push(requireCastAction(cast));
  return list;
}

/**
 * Every offer the timeline draws from this module: the bar's picker, add button and Refresh;
 * each answered door; per line its gutter and its text or the box that stands in for it; per shot
 * its bracket and two handles; then the wardrobe strip.
 */
export function controls(state: TimelineState): readonly Offer[] {
  const list: Offer[] = [pickerAction(state.sceneId), addShotAction(state.sceneId), reloadAction()];
  const scene = state.undecomposed;
  if (scene) {
    for (const door of [decomposeDoor(), byHandDoor(scene.sceneId, scene.firstLine)]) {
      const check = state.verdicts[doorKey(scene.sceneId, door)];
      if (check) list.push(doorAction(door, check));
    }
  }
  for (const line of state.lines ?? []) {
    list.push(gutterAction(line), line.id === state.editing ? lineBox(line) : lineTextAction(line));
  }
  for (const shot of state.shots ?? []) {
    list.push(bracketAction(shot.id), handleAction(shot.id, 'start'), handleAction(shot.id, 'end'));
  }
  list.push(...wardrobeControls(state.wardrobe ?? [], state.cast ?? null));
  return list;
}
