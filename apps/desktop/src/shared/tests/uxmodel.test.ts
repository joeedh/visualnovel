import { UX_MODEL, UX_OFFER, UX_RECORD, paletteMatches } from '../uxmodel.js';

const accepted = {
  ok     : true,
  id     : 'asset.export',
  props  : { hash: 'a1b2' },
  label  : 'Export',
  tooltip: 'Save a copy of this asset outside the project.',
};

const refused = {
  ok     : false,
  id     : 'story.deleteScene',
  label  : 'delete arrival',
  tooltip: 'Remove arrival and the shots that illustrate it',
  refusal: { reason: 'arrival is the entry scene' },
};

const situated = { editor: 'asset', module: 'assetview', situation: 'plate' };

describe('the derived model schema', () => {
  it('reads an offer on either branch', () => {
    expect(UX_OFFER.parse(accepted)).toEqual(accepted);
    expect(UX_OFFER.parse(refused)).toEqual(refused);
  });

  it('refuses a refusal with no sentence', () => {
    expect(UX_OFFER.safeParse({ ...refused, refusal: { reason: '' } }).success).toBe(false);
  });

  it('refuses a field it does not name', () => {
    expect(UX_OFFER.safeParse({ ...accepted, note: 'fixture prose' }).success).toBe(false);
    expect(
      UX_RECORD.safeParse({
        ...situated,
        via  : 'control',
        key  : 'cmd:asset.export',
        offer: accepted,
        rect : {},
      }).success,
    ).toBe(false);
  });

  it('reads a control record and a menu record', () => {
    const control = {
      ...situated,
      via       : 'control',
      key       : 'cmd:story.deleteScene',
      widgetPath: 'documents/story-deletescene~a1b2c3d4',
      offer     : refused,
      effects   : [{ id: 'story.deleteScene' }],
      reasonFrom: 'stack',
    };
    const menu = {
      editor   : 'documents',
      module   : 'doctree',
      situation: 'every-kind',
      via      : 'menu',
      when     : 'scene:sample',
      id       : 'story.decomposeAll',
      label    : 'Decompose',
      form     : true,
    };
    expect(UX_RECORD.parse(control)).toEqual(control);
    expect(UX_RECORD.parse(menu)).toEqual(menu);
  });

  it('reads a control whose click does several things, and a menu entry with a tail', () => {
    const then = [{ id: 'view.open', props: { editor: 'script', where: 'here' } }];
    const offer = {
      ok     : true,
      id     : 'ui.publish',
      on     : 'scene/arrival',
      props  : { sceneId: 'arrival' },
      label  : 'arrival',
      tooltip: 'Show arrival in the Script pane.',
      then,
    };
    const control = {
      ...situated,
      via       : 'control',
      key       : 'item:scene/arrival',
      widgetPath: 'script/ui-publish~a1b2c3d4',
      offer,
      effects : [{ id: 'ui.publish', props: { sceneId: 'arrival' } }, ...then],
      shortcut: 'Ctrl+Z',
    };
    expect(UX_RECORD.parse(control)).toEqual(control);
    const menu = {
      editor   : 'header',
      module   : 'headermenus',
      situation: 'open',
      via      : 'menu',
      when     : 'header/view',
      id       : 'window.new',
      label    : 'Move Pane to New Window',
      tooltip  : 'Open this pane in a window of its own.',
      then     : [{ id: 'view.close' }],
      shortcut : 'Ctrl+Shift+N',
    };
    expect(UX_RECORD.parse(menu)).toEqual(menu);
    expect(UX_RECORD.safeParse({ ...control, effects: [] }).success).toBe(false);
  });

  it('knows every anchor home, and only those', () => {
    expect(
      UX_RECORD.safeParse({
        ...situated,
        editor: 'header',
        via   : 'menu',
        when  : 'x',
        id    : 'y',
        label : '',
      }).success,
    ).toBe(true);
    expect(
      UX_RECORD.safeParse({
        ...situated,
        editor: 'toolbar',
        via   : 'menu',
        when  : 'x',
        id    : 'y',
        label : '',
      }).success,
    ).toBe(false);
  });

  it('accepts an empty model and a palette-only entry under the one-star grammar', () => {
    const empty = { situations: [], records: [], paletteOnly: [], shortcuts: [], menuExempt: [] };
    expect(UX_MODEL.parse(empty)).toEqual(empty);
    for (const match of ['workspace.*', '*.list', 'command.check']) {
      expect(UX_MODEL.safeParse({ ...empty, paletteOnly: [{ match, why: 'w' }] }).success).toBe(
        true,
      );
    }
    for (const match of ['*', 'a.*.b', '*.a.*', '']) {
      expect(UX_MODEL.safeParse({ ...empty, paletteOnly: [{ match, why: 'w' }] }).success).toBe(
        false,
      );
    }
  });
});

describe('paletteMatches', () => {
  it('matches an id exactly, a namespace by prefix and a name by suffix', () => {
    expect(paletteMatches('command.check', 'command.check')).toBe(true);
    expect(paletteMatches('command.check', 'command.checks')).toBe(false);
    expect(paletteMatches('workspace.*', 'workspace.open')).toBe(true);
    expect(paletteMatches('workspace.*', 'workspaces.open')).toBe(false);
    expect(paletteMatches('*.list', 'asset.list')).toBe(true);
    expect(paletteMatches('*.list', 'asset.listing')).toBe(false);
  });
});
