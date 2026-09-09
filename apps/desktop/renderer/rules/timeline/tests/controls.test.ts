import {
  addShotAction,
  byHandDoor,
  controls,
  decomposeDoor,
  doorAction,
  doorKey,
  wardrobeControls,
  type TimelineState,
} from '../controls.js';
import type { ShotCast } from '../cast.js';
import type { OutfitRow } from '../wardrobe.js';
import { duplicateKeys, keyOf } from '../../anchors.js';
import type { CommandCheck } from '../../../../src/shared/ipc';

const ACCEPT: CommandCheck = { state: 'accept', message: 'Priced at one call.' };
const REFUSE: CommandCheck = { state: 'refuse', message: 'The scene is already storyboarded.' };
const UNDECLARED: CommandCheck = { state: 'undeclared', message: '' };

const state = (over: Partial<TimelineState> = {}): TimelineState => ({
  sceneId : 'intro',
  verdicts: {},
  ...over,
});

describe('addShotAction', () => {
  it('opens the form on the scene on screen', () => {
    expect(addShotAction('intro')).toEqual({
      ok     : true,
      id     : 'story.newShot',
      props  : { scene: 'intro' },
      label  : '+ shot',
      tooltip:
        'Place a shot by hand over lines you name — a new frame to render. Opens the command, priced before it runs.',
      form   : true,
    });
  });

  it('refuses with no scene on screen', () => {
    expect(addShotAction('')).toMatchObject({
      ok     : false,
      id     : 'story.newShot',
      refusal: { reason: 'No scene is on screen.' },
    });
  });
});

describe('decomposeDoor', () => {
  it('opens decomposeAll with nothing prefilled', () => {
    expect(decomposeDoor()).toEqual({
      id     : 'story.decomposeAll',
      props  : {},
      label  : 'decompose',
      tooltip:
        'Ask the writing model to storyboard every scene that has none — one model call per scene, priced in the dialog before it runs.',
      form   : true,
    });
  });
});

describe('byHandDoor', () => {
  it('opens newShot on the scene and its first line, keyed apart from the bar button', () => {
    const door = byHandDoor('intro', 's:L1');
    expect(door).toEqual({
      id     : 'story.newShot',
      props  : { scene: 'intro', lines: 's:L1' },
      on     : 'undecomposed',
      label  : 'place a shot by hand',
      tooltip:
        'Create the storyboard for intro yourself, one shot at a time — which ends decomposition for this scene.',
      form   : true,
    });
    expect(keyOf(door)).toBe('cmd:story.newShot#undecomposed');
    expect(keyOf(door)).not.toBe(keyOf(addShotAction('intro')));
  });
});

describe('doorKey', () => {
  it('carries the scene the door was asked about', () => {
    expect(doorKey('intro', decomposeDoor())).toBe('intro/cmd:story.decomposeAll');
    expect(doorKey('intro', byHandDoor('intro', 's:L1'))).toBe(
      'intro/cmd:story.newShot#undecomposed',
    );
  });
});

describe('doorAction', () => {
  it('offers the door with its own props once accepted', () => {
    expect(doorAction(byHandDoor('intro', 's:L1'), ACCEPT)).toEqual({
      ok: true,
      ...byHandDoor('intro', 's:L1'),
    });
  });

  // A command that states no precondition has not refused, so the door still opens
  it('offers the door when the check is undeclared', () => {
    expect(doorAction(decomposeDoor(), UNDECLARED)).toMatchObject({ ok: true });
  });

  it('greys the door with the command’s own sentence when refused', () => {
    const refused = doorAction(decomposeDoor(), REFUSE);
    expect(refused).toMatchObject({
      ok     : false,
      id     : 'story.decomposeAll',
      label  : 'decompose',
      refusal: { reason: REFUSE.message },
    });
    expect(refused).not.toHaveProperty('props');
  });
});

describe('controls', () => {
  const undecomposed = { sceneId: 'intro', firstLine: 's:L1' };
  const both = state({
    undecomposed,
    verdicts: {
      [doorKey('intro', decomposeDoor())]               : ACCEPT,
      [doorKey('intro', byHandDoor('intro', 's:L1'))]: REFUSE,
    },
  });

  it('is the add button alone for a decomposed scene, and with no scene', () => {
    expect(controls(state()).map(keyOf)).toEqual(['cmd:story.newShot']);
    expect(controls(state({ sceneId: '' })).map(keyOf)).toEqual(['cmd:story.newShot']);
  });

  it('adds a door only once its verdict is in', () => {
    expect(controls(state({ undecomposed })).map(keyOf)).toEqual(['cmd:story.newShot']);
    const one = state({
      undecomposed,
      verdicts: { [doorKey('intro', decomposeDoor())]: ACCEPT },
    });
    expect(controls(one).map(keyOf)).toEqual(['cmd:story.newShot', 'cmd:story.decomposeAll']);
  });

  // A verdict kept for another scene is not this scene's answer
  it('ignores a verdict keyed to a scene that is no longer on screen', () => {
    const stale = state({
      undecomposed,
      verdicts: { [doorKey('outro', decomposeDoor())]: ACCEPT },
    });
    expect(controls(stale).map(keyOf)).toEqual(['cmd:story.newShot']);
  });

  it('lists every control the editor draws, each key once', () => {
    for (const s of [state(), state({ undecomposed }), both]) {
      const listed = controls(s);
      const each = [addShotAction(s.sceneId)];
      if (s.undecomposed) {
        for (const door of [decomposeDoor(), byHandDoor('intro', 's:L1')]) {
          const check = s.verdicts[doorKey('intro', door)];
          if (check) each.push(doorAction(door, check));
        }
      }
      expect(new Set(listed.map(keyOf))).toEqual(new Set(each.map(keyOf)));
      expect(duplicateKeys(listed)).toEqual([]);
    }
  });
});

describe('wardrobeControls', () => {
  const sheet = { id: 'uniform', origin: 'default' } as const;
  const row = (level: 'scene' | 'shot', character: string): OutfitRow => ({
    level,
    scene: 'intro',
    ...(level === 'shot' ? { shot: 'intro__s1' } : {}),
    character,
    outfits  : ['uniform'],
    value    : '',
    effective: sheet,
    inherits : sheet,
  });
  const cast: ShotCast = {
    scene   : 'intro',
    shot    : 'intro__s1',
    framed  : ['aiko'],
    spare   : ['ren'],
    required: true,
    variant : 'day',
    variants: ['day'],
  };

  it('lists the strip in draw order, each key once', () => {
    const rows = [row('scene', 'aiko'), row('scene', 'ren'), row('shot', 'aiko')];
    expect(wardrobeControls(rows, cast).map(keyOf)).toEqual([
      'cmd:story.setSceneOutfit#scene/aiko',
      'cmd:story.setSceneOutfit#scene/ren',
      'cmd:story.setVariant',
      'cmd:story.setOutfit#shot/aiko',
      'cmd:story.setSubjects#drop/aiko',
      'cmd:story.setSubjects#add',
      'cmd:story.requireCast',
    ]);
    expect(duplicateKeys(wardrobeControls(rows, cast))).toEqual([]);
  });

  it('leaves out the add select once everyone is framed, and the shot half with no shot', () => {
    const rows = [row('scene', 'aiko'), row('shot', 'aiko')];
    const keys = wardrobeControls(rows, { ...cast, spare: [] }).map(keyOf);
    expect(keys).not.toContain('cmd:story.setSubjects#add');
    expect(wardrobeControls([row('scene', 'aiko')], null).map(keyOf)).toEqual([
      'cmd:story.setSceneOutfit#scene/aiko',
    ]);
    expect(wardrobeControls([], cast)).toEqual([]);
  });

  it('is listed by controls after the bar and the doors', () => {
    const listed = controls(state({ wardrobe: [row('scene', 'aiko')], cast }));
    expect(listed.map(keyOf)).toEqual([
      'cmd:story.newShot',
      'cmd:story.setSceneOutfit#scene/aiko',
      'cmd:story.setVariant',
      'cmd:story.setSubjects#add',
      'cmd:story.requireCast',
    ]);
  });
});
