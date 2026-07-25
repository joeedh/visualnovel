/** The character-approval gate (P3) as commands: inspect candidates, approve one. */
import { defineFor, prop } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const gateCandidates = define({
  id: 'gate.candidates',
  title: 'Gate candidates',
  description: "List a character's generated portrait candidates and which is accepted.",
  mutating: false,
  props: { characterId: prop.string('the character to inspect') },
  async run({ characterId }, ctx) {
    const candidates = await ctx.host.session.gateCandidates(characterId);
    return {
      message: `${candidates.length} candidate(s) for ${characterId}.`,
      data: candidates,
    };
  },
});

export const gateApprove = define({
  id: 'gate.approve',
  title: 'Approve portrait',
  description: "Approve a character's portrait by asset hash, clearing them from the gate.",
  mutating: true,
  props: {
    characterId: prop.string('the character to approve'),
    hash: prop.string('the asset hash to approve'),
  },
  async run({ characterId, hash }, ctx) {
    const result = await ctx.host.session.approveCharacter(characterId, hash);
    if (!result.ok) throw new Error(result.message);
    return {
      message: result.message,
      data: result,
      // Mirrors what `approveCharacter` touches: the input doc, the visible portrait, and
      // the manifest entry flipped to accepted.
      written: [
        `characters/${characterId}/character.md`,
        `vngen/work/characters/${characterId}/approved.png`,
        'vngen/build/manifest.json',
      ],
    };
  },
});
