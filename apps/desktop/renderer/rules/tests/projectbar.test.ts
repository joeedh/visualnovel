import { setModelCatalog } from '@vn/gengraph';
import {
  applyStyleAction,
  builtinSkillAction,
  controls,
  imageModelAction,
  imageModelRows,
  reloadAction,
  styleBox,
} from '../projectbar.js';
import { refreshModelsAction } from '../models.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { BuiltinSkillView } from '../../../src/shared/ipc.js';

const CATALOG: BuiltinSkillView[] = [
  { id: 'branching', name: 'Branching', description: 'Add a choice.', enabled: true },
  { id: 'full-production', name: 'Full production', description: 'Premise to VN.', enabled: false },
  { id: 'new-character', name: 'New character', description: 'Add a character.', enabled: true },
];

describe('builtinSkillAction', () => {
  it('offers the list the file will hold, with this skill flipped, in catalog order', () => {
    expect(builtinSkillAction(true, CATALOG[0]!, CATALOG)).toEqual({
      ok     : true,
      id     : 'project.setBuiltinSkills',
      on     : 'branching',
      label  : 'Branching',
      props  : { ids: ['new-character'] },
      tooltip: 'Turn branching off — the agent stops seeing it. Add a choice.',
    });
    expect(builtinSkillAction(true, CATALOG[1]!, CATALOG)).toMatchObject({
      ok     : true,
      on     : 'full-production',
      props  : { ids: ['branching', 'full-production', 'new-character'] },
      tooltip: 'Turn full-production on — the agent can then follow it. Premise to VN.',
    });
  });

  it('refuses with no project', () => {
    expect(builtinSkillAction(false, CATALOG[0]!, CATALOG)).toMatchObject({
      ok     : false,
      id     : 'project.setBuiltinSkills',
      on     : 'branching',
      refusal: { reason: 'No project is open.' },
    });
  });
});

describe('applyStyleAction', () => {
  it('writes the style the box supplies once something in it has changed', () => {
    expect(applyStyleAction(true, true)).toEqual({
      ok      : true,
      id      : 'project.setArtStyle',
      props   : {},
      label   : 'Apply',
      tooltip : 'Write these settings back to project.yaml',
      supplies: ['style'],
    });
  });

  it('refuses with no project, and with nothing to write', () => {
    expect(applyStyleAction(false, true)).toMatchObject({
      ok     : false,
      id     : 'project.setArtStyle',
      refusal: { reason: 'No project is open.' },
    });
    expect(applyStyleAction(true, false)).toMatchObject({
      ok     : false,
      id     : 'project.setArtStyle',
      refusal: { reason: 'No changes' },
    });
  });
});

describe('styleBox', () => {
  it('is the same write as Apply, supplied by the box, refused only with no project', () => {
    expect(styleBox(true)).toEqual({
      ok      : true,
      id      : 'project.setArtStyle',
      props   : {},
      on      : 'style',
      label   : 'Art style',
      tooltip : 'The sentence every image prompt opens with. Applying it re-keys every image task.',
      supplies: ['style'],
    });
    expect(styleBox(false)).toMatchObject({
      ok     : false,
      refusal: { reason: 'No project is open.' },
    });
    expect(reloadAction()).toMatchObject({ props: { what: 'reload' }, on: 'reload', label: '⟳' });
  });
});

describe('imageModelAction', () => {
  it('names the model in use, and the rows supply the id', () => {
    expect(imageModelAction(true, 'openai/gpt-image-2')).toMatchObject({
      ok      : true,
      id      : 'project.setImageModel',
      props   : {},
      label   : 'openai/gpt-image-2',
      supplies: ['model'],
    });
    expect(imageModelAction(true, '').label).toBe('model…');
    expect(imageModelAction(false, 'x')).toMatchObject({
      ok     : false,
      refusal: { reason: 'No project is open.' },
    });
  });
});

describe('imageModelRows', () => {
  it('lists the shipped Gemini ids and says how each row draws, with no catalog set', () => {
    const rows = imageModelRows('gemini-2.5-flash-image');
    expect(rows.map((row) => row.id)).toEqual(['gemini-2.5-flash-image']);
    expect(rows[0]?.tooltip).toContain('through Gemini');
  });

  it('adds the current value as a row when the list lacks it, saying OpenRouter routes it', () => {
    const rows = imageModelRows('openai/gpt-image-2');
    expect(rows.map((row) => row.id)).toEqual(['gemini-2.5-flash-image', 'openai/gpt-image-2']);
    expect(rows[1]?.tooltip).toContain('routed by OpenRouter; not zero-data-retention');
  });

  it('draws the catalog it is given, or the snapshot the shell set', () => {
    const catalog = {
      shipped   : ['gemini-2.5-flash-image'],
      openrouter: [{ id: 'openai/gpt-image-2', name: 'GPT Image 2', aspects: [], seed: false }],
      default   : 'gemini-2.5-flash-image',
      asOf      : '2026-09-15',
    };
    const ids = ['gemini-2.5-flash-image', 'openai/gpt-image-2'];
    expect(imageModelRows('gemini-2.5-flash-image', catalog).map((row) => row.id)).toEqual(ids);
    setModelCatalog(catalog);
    try {
      expect(imageModelRows('gemini-2.5-flash-image').map((row) => row.id)).toEqual(ids);
    } finally {
      setModelCatalog(undefined);
    }
  });
});

describe('refreshModelsAction', () => {
  it('says the cached listing’s date, or that there is none', () => {
    expect(refreshModelsAction(true, '2026-09-15')).toMatchObject({
      ok     : true,
      id     : 'models.refresh',
      props  : {},
      label  : 'Refresh models',
      tooltip: expect.stringContaining('from 2026-09-15') as string,
    });
    expect(refreshModelsAction(true, undefined).tooltip).toContain('none are cached yet');
    expect(refreshModelsAction(false, undefined)).toMatchObject({
      ok     : false,
      refusal: { reason: 'No project is open.' },
    });
  });
});

describe('controls', () => {
  it('lists Apply, reload, the box, the picker, the refresh and a box per skill, each key once', () => {
    for (const state of [
      {
        opened       : true,
        dirty        : true,
        imageModel   : 'gemini-2.5-flash-image',
        catalogAsOf  : '2026-09-15',
        builtinSkills: CATALOG,
      },
      { opened: false, dirty: false, imageModel: '', builtinSkills: CATALOG },
    ]) {
      const listed = controls(state);
      expect(listed).toEqual([
        applyStyleAction(state.opened, state.dirty),
        reloadAction(),
        styleBox(state.opened),
        imageModelAction(state.opened, state.imageModel),
        refreshModelsAction(state.opened, state.catalogAsOf),
        ...CATALOG.map((skill) => builtinSkillAction(state.opened, skill, CATALOG)),
      ]);
      expect(duplicateKeys(listed)).toEqual([]);
    }
    expect(
      controls({
        opened       : true,
        dirty        : true,
        imageModel   : 'gemini-2.5-flash-image',
        builtinSkills: CATALOG,
      }).map(keyOf),
    ).toEqual([
      'cmd:project.setArtStyle',
      'fx:pane.view#reload',
      'cmd:project.setArtStyle#style',
      'cmd:project.setImageModel',
      'cmd:models.refresh',
      'cmd:project.setBuiltinSkills#branching',
      'cmd:project.setBuiltinSkills#full-production',
      'cmd:project.setBuiltinSkills#new-character',
    ]);
  });
});
