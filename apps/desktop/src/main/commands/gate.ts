/** Commands over the character-approval gate (P3): inspect candidates, approve one, lock one. */
import { defineFor, prop } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const gateCandidates = define({
  id         : 'gate.candidates',
  title      : 'Gate candidates',
  description: "List a character's generated portrait candidates and which is accepted.",
  notes      : 'Pending portrait candidates for one character.',
  mutating   : false,
  props      : { characterId: prop.string('the character to inspect') },
  async run({ characterId }, ctx) {
    const candidates = await ctx.host.session.gateCandidates(characterId);
    return {
      message: `${candidates.length} candidate(s) for ${characterId}.`,
      data   : candidates,
    };
  },
});

export const gateApprove = define({
  id         : 'gate.approve',
  title      : 'Approve portrait',
  description: "Approve a character's portrait by asset hash, clearing them from the gate.",
  notes:
    'Holds and accepts the portrait row; the store mirrors it onto `character.md` and `approved.png`.',
  mutating   : true,
  affects: [
    'characters',
    'wiki',
    'vngen/work/characters',
    'assets/manifest.json',
    'vngen/build/manifest.json',
  ],
  props: {
    characterId: prop.string('the character to approve'),
    hash       : prop.string('the asset hash to approve'),
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
          ok    : false,
          reason: state.candidates
            ? `Name the portrait to approve — ${state.candidates} on file for ${characterId}, which \`gate.candidates\` lists.`
            : `${characterId} has no portrait yet — run the pipeline before approving one.`,
        };
      }
      return {
        ok    : false,
        reason: `${characterId} has no candidate ${hash} (${state.candidates} on file).`,
      };
    }
    if (state.suspended) {
      return { ok: false, reason: `${hash.slice(0, 8)} is suspended: ${state.suspended}.` };
    }
    // Already approved is not a refusal, because an author changes their mind by approving a
    // second candidate and the command supports that
    return {
      ok  : true,
      note: state.approved
        ? `Would replace ${characterId}'s approved portrait.`
        : `Would clear ${characterId} from the gate.`,
    };
  },
  async run({ characterId, hash }, ctx) {
    const result = await ctx.host.session.approveCharacter(characterId, hash);
    if (!result.ok) throw new Error(result.message);
    // The sheet, the visible portrait and the manifest entry flipped to accepted, as
    // `approveCharacter` names them: a sheet discovered under `wiki/` is reported where it is, and
    // a portrait's manifest is whichever root holds the bytes.
    return { message: result.message, data: result, written: result.written ?? [] };
  },
});

export const gateLock = define({
  id         : 'gate.lock',
  title      : 'Lock portrait',
  description:
    "Hold a character's approval at the portrait their sheet names, whatever their slot comes to hold; or release that hold.",
  notes:
    'Writes `status: locked` (or `approved` again) onto `character.md`; the manifest is untouched.',
  mutating   : true,
  affects    : ['characters', 'wiki'],
  props: {
    characterId: prop.string('the character to lock'),
    locked     : prop.boolean('false to release the lock', { default: true }),
  },
  async check({ characterId, locked }, ctx) {
    const state = await ctx.host.session.gateLockState(characterId);
    if (!state.character) return { ok: false, reason: `No character "${characterId}".` };
    if (locked) {
      if (!state.mirror) {
        return {
          ok    : false,
          reason: `${characterId} has no approved portrait to lock — approve one with gate.approve first.`,
        };
      }
      return {
        ok  : true,
        note: state.locked
          ? `${characterId} is already locked.`
          : `Would hold ${characterId}'s approval at ${state.mirror.slice(0, 8)} until unlocked.`,
      };
    }
    if (!state.locked) return { ok: false, reason: `${characterId} is not locked.` };
    return {
      ok  : true,
      note: `Would let ${characterId}'s approval follow their portrait slot again.`,
    };
  },
  async run({ characterId, locked }, ctx) {
    const result = await ctx.host.session.lockCharacter(characterId, locked);
    if (!result.ok) throw new Error(result.message);
    return { message: result.message, written: result.written };
  },
});
