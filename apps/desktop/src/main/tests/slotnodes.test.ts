/**
 * The Task Graph pane's slots: `slotNodes` carries the solver's answer across the wire in its
 * order, with the row a slot holds under `hash`.
 */
import { projectConfig, type Asset } from '@vn/types';
import { solve, type Solution } from '@vn/constraint-solver';
import { stillsFamily } from '@vn/stills';
import { character, location, model, scene } from '@vn/testkit';
import { slotNodes } from '../session/pipeline.js';

const config = projectConfig.parse({
  title    : 'Test',
  art_style: 'watercolor',
  models   : { vision: ['gemini', 'claude'] },
});

/** The portrait row Aiko is approved with: current in her slot, and accepted by a person. */
const PORTRAIT: Asset = {
  hash      : 'p-aiko',
  ext       : 'png',
  kind      : 'portrait',
  sourceTask: 'task-p-aiko',
  refs      : [],
  modelId   : 'm',
  accepted  : true,
  current   : true,
  satisfies : [{ characterId: 'aiko' }],
};

/** Aiko is approved and cast in the one scene, whose storyboard holds one shot of her at the cafe. */
function solved(): Solution {
  const cafe = location('cafe');
  cafe.variants = [
    { id: 'day', description: '' },
    { id: 'night', description: 'lamps on' },
  ];
  const m = model(
    [character('aiko', 'approved', 'p-aiko')],
    [scene('arrival', ['aiko'], 'cafe')],
    [cafe],
  );
  m.production.set('arrival', {
    shots: [
      {
        id         : 'arrival__a',
        sceneId    : 'arrival',
        framing    : 'medium',
        location   : 'day',
        subjects   : [{ characterId: 'aiko' }],
        coversLines: [],
      },
    ],
  });
  return solve(stillsFamily, {
    model: m,
    config,
    assets: [PORTRAIT],
    tasks : { get: () => undefined },
  });
}

describe('slotNodes', () => {
  it("answers the solver's slots in its order, in the shape the pane reads", () => {
    const states = solved();
    const nodes = slotNodes(states);
    expect(nodes.map((n) => n.key)).toEqual(states.order);
    expect(nodes).toHaveLength(states.slots.size);
    // The row a slot holds is `pick` on the state and `hash` on the node
    const portrait = nodes.find((n) => n.key === 'portrait:aiko')!;
    expect(portrait.hash).toBe(states.slots.get('portrait:aiko')!.pick);
    expect(portrait).toEqual({
      key       : 'portrait:aiko',
      binding   : { kind: 'portrait', characterId: 'aiko' },
      label     : states.slots.get('portrait:aiko')!.label,
      refs      : [],
      taskHash  : states.slots.get('portrait:aiko')!.taskHash,
      hash      : 'p-aiko',
      candidates: ['p-aiko'],
      approved  : true,
    });
    const shot = nodes.find((n) => n.key === 'shot:arrival/arrival__a')!;
    expect(shot.blocked).toContain('has not been rendered');
    expect('hash' in shot).toBe(false);
  });
});
