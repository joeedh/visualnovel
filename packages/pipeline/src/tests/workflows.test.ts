/**
 * `familyOf` answers a family over the facts a host builds. A second workflow's family that reads
 * facts of its own is registered by pairing it with a builder, and no caller's types change. No
 * second workflow exists, so the family here is a toy, checked against `familyOf`'s return type.
 */
import {
  slot,
  solve,
  withFacts,
  type Family,
  type SlotKind,
  type SolverFacts,
} from '@vn/constraint-solver';
import { stillsFamily } from '@vn/stills';
import { projectConfig } from '@vn/types';
import { character, location, model, scene } from '@vn/testkit';
import { familyOf, waveFacts, type HostFacts } from '../index.js';

const config = projectConfig.parse({ title: 'Test' });

/** The facts of a toy family that cuts reels. No host builds them. */
interface ReelFacts extends SolverFacts {
  readonly reels: readonly string[];
}

/** Fills one reel per scene. It borrows a stills task kind, since `TaskKind` names only those. */
const reelKind: SlotKind<ReelFacts, { scene: string }, 'portrait'> = {
  prefix    : 'reel',
  task      : 'portrait',
  key       : (b) => `reel:${b.scene}`,
  parse     : (key) => (key.startsWith('reel:') ? { scene: key.slice(5) } : undefined),
  label     : (b) => `reel ${b.scene}`,
  refs      : () => [],
  resolve: (b) => ({
    ok  : true,
    plan: { characterId: b.scene, prompt: '', refs: [], params: { modelId: 'toy' } },
  }),
  fromInputs: (inputs) => (inputs.characterId ? { scene: inputs.characterId } : undefined),
  candidates: () => [],
  approved  : () => false,
};

const reels: Family<ReelFacts> = {
  id       : 'reels',
  kinds    : [reelKind],
  enumerate: (facts) => facts.reels.map((id) => slot(reelKind, { scene: id })),
  kept     : (facts) => reels.enumerate(facts),
  owed     : () => [],
  gates    : () => [],
  slotOf   : () => undefined,
  drawnFrom: (row) => ({ refs: row.refs }),
};

/** What the registry holds for every workflow. */
type Registered = ReturnType<typeof familyOf>;

describe('familyOf', () => {
  it('answers the stills family itself for vn', () => {
    expect(familyOf('vn')).toBe(stillsFamily);
  });

  it('takes a family that reads facts of its own once it is paired with a builder', () => {
    const registered: Registered = withFacts(reels, (host: HostFacts) => ({
      reels: [...host.model.scenes.keys()],
    }));
    // @ts-expect-error A family over facts no host builds cannot be registered as it is
    const bare: Registered = reels;
    expect(bare).toBe(reels);

    const m = model(
      [character('aiko')],
      [scene('arrival', ['aiko'], 'cafe'), scene('ball', ['aiko'], 'cafe')],
      [location('cafe')],
    );
    const solved = solve(registered, waveFacts({ model: m, config }));
    expect([...solved.slots.keys()]).toEqual(['reel:arrival', 'reel:ball']);
    expect(solved.slots.get('reel:ball')!.taskHash).toBeDefined();
  });
});
