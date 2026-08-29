/** Commands over the character-approval gate (P3): inspect candidates, approve one. */
import { defineFor, prop } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const gateCandidates = define({
  id: 'gate.candidates',
  title: 'Gate candidates',
  description: "List a character's generated portrait candidates and which is accepted.",
  notes: 'Pending portrait candidates for one character.',
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
  notes: 'Flips `character.md`; writes the approved PNG + manifest.',
  mutating: true,
  props: {
    characterId: prop.string('the character to approve'),
    hash: prop.string('the asset hash to approve'),
  },
  async check({ characterId, hash }, ctx) {
    const state = await ctx.host.session.gateCandidacy(characterId, hash);
    if (!state.character) return { ok: false, reason: `No character "${characterId}".` };
    if (!state.candidate) {
      // An empty hash is ordinary rather than a typo, because the tasks and graph editors open
      // this form on a character and leave the choice of portrait to the author. "has no candidate
      // ''" would read as a failed lookup, so the refusal names the unanswered field instead
      if (!hash) {
        return {
          ok: false,
          reason: state.candidates
            ? `Name the portrait to approve — ${state.candidates} on file for ${characterId}, which \`gate.candidates\` lists.`
            : `${characterId} has no portrait yet — run the pipeline before approving one.`,
        };
      }
      return {
        ok: false,
        reason: `${characterId} has no candidate ${hash} (${state.candidates} on file).`,
      };
    }
    if (state.suspended) {
      return { ok: false, reason: `${hash.slice(0, 8)} is suspended: ${state.suspended}.` };
    }
    // Already approved is not a refusal, because an author changes their mind by approving a
    // second candidate and the command supports that
    return {
      ok: true,
      note: state.approved
        ? `Would replace ${characterId}'s approved portrait.`
        : `Would clear ${characterId} from the gate.`,
    };
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
