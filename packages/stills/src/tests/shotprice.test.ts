import { projectConfig, shotsOf, type Shot } from '@vn/types';
import { makeTask } from '@vn/taskgraph';
import { character, location, model, scene } from '@vn/testkit';
import {
  imageParams,
  locationInputs,
  priceShotChanges,
  type SlotResolveContext,
} from '../index.js';

const config = projectConfig.parse({ title: 'Test', art_style: 'ink', models: {} });

const frame = (id: string, extra: Partial<Shot> = {}): Shot => ({
  id,
  sceneId    : 'arrival',
  framing    : 'medium',
  location   : 'day',
  subjects   : [{ characterId: 'aiko' }, { characterId: 'ren' }],
  coversLines: [],
  ...extra,
});

/** Two of three drawn shots share a seeded group, and the café's plate has rendered. */
function ctx(): SlotResolveContext {
  const arrival = scene('arrival', ['aiko', 'ren'], 'cafe');
  const m = model(
    [character('aiko', 'approved', 'p-aiko'), character('ren', 'approved', 'p-ren')],
    [arrival],
    [location('cafe')],
  );
  const plate = makeTask(
    'location_ref',
    locationInputs(m.locations.get('cafe')!, 'day', config, imageParams(config)),
  );
  const done = { ...plate, status: 'done' as const, output: 'plate1' };
  const shots: Shot[] = [
    frame('arrival__a', { sheet: 'g1', image: 'img-a' }),
    frame('arrival__b', { sheet: 'g1', image: 'img-b' }),
    frame('arrival__c', { image: 'img-c' }),
  ];
  m.production.set('arrival', { shots, sheets: { g1: { seed: 2, notes: 'one long table' } } });
  return {
    model: m,
    config,
    graph: { get: (hash) => (hash === plate.hash ? done : undefined) },
  };
}

describe('priceShotChanges', () => {
  it('counts the other members of a changed shot’s group, which re-key with it', () => {
    const c = ctx();
    const a = shotsOf(c.model, 'arrival')[0]!;
    const shot = { ...a, subjects: [{ characterId: 'aiko' }] };
    expect(priceShotChanges(c, [{ sceneId: 'arrival', shot }])).toEqual({ moved: 2, rendered: 2 });
  });

  it('counts only the changed shot when it is in no group', () => {
    const c = ctx();
    const third = shotsOf(c.model, 'arrival')[2]!;
    const shot = { ...third, subjects: [{ characterId: 'aiko' }] };
    expect(priceShotChanges(c, [{ sceneId: 'arrival', shot }])).toEqual({ moved: 1, rendered: 1 });
  });

  it('counts a member once when it is both changed and a sibling of a change', () => {
    const c = ctx();
    const [a, b] = shotsOf(c.model, 'arrival');
    const changes = [a!, b!].map((s) => ({
      sceneId: 'arrival',
      shot   : { ...s, subjects: [{ characterId: 'aiko' }] },
    }));
    expect(priceShotChanges(c, changes)).toEqual({ moved: 2, rendered: 2 });
  });
});
