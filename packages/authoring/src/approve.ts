/**
 * Approving pictures on the author's say-so — the one act in this agent where the *authority*
 * comes from the author's own words rather than from the agent's argument for them.
 *
 * Approval is what turns a draft into the thing everything downstream is drawn from, and it is
 * irreversible in the sense that matters: a run continues past a gate that has been cleared. So
 * the tool is built to make one specific mistake impossible — the agent deciding, mid-turn and
 * for reasons of its own, that the author would surely want all of this approved.
 *
 * Three checks, in order, and each one can only narrow what the one before it allowed:
 *
 * 1. **The list is the project's, not the model's.** The host enumerates what is approvable now,
 *    upstream first, and nothing outside that list can be approved however it is named.
 * 2. **A small model reads what the author actually typed** — not what the agent says they meant.
 *    It answers two questions at once, because they are the same question: did they ask for this,
 *    and if so which of these pictures did they mean. It never sees the agent's reasoning.
 * 3. **The author confirms the final list**, item by item, before anything is written.
 *
 * The triage model is deliberately small: this is a reading-comprehension question about a short
 * piece of text, which is what a small model is good at, and making it cheap is what lets step 2
 * be unconditional rather than something worth skipping.
 */
import { z } from 'zod';
import type { ChatBackend } from '@vn/providers';
import { withStructuredRetry } from '@vn/providers';

/**
 * The model that reads the author's words. Named here rather than taken from the project, because
 * this is not the conversation's model and it is not the author's choice: it is a fixed part of
 * how the check works, and a project that swapped it for the model being checked would be
 * checking the agent's homework with the agent.
 */
export const TRIAGE_MODEL = 'claude-haiku-4-5';

/** How far back the author's own words are read. Recent, because consent goes stale. */
export const SAID_WINDOW = 6;

/** One picture the author could approve right now, as the host enumerates it. */
export interface Approvable {
  hash: string;
  /** The manifest kind — `sheet`, `plate`, `shot`, `portrait`. */
  kind: string;
  /** The project's own name for it: `Aiko — uniform sheet`. What the author will read. */
  label: string;
  /** The slot it is a candidate for, which is what makes two drafts of one thing distinguishable. */
  slot: string;
  /**
   * Which door approving it goes through. A portrait is the P3 character gate — approving one
   * also writes `character.md` and `approved.png` — and everything else is `asset.accept`.
   */
  door: 'gate' | 'accept';
  /** The character a portrait belongs to. Absent on every other kind. */
  characterId?: string;
  /** Why it cannot be approved yet — something upstream is unapproved. Listed, never approved. */
  blocked?: string;
}

/** The approval seam, wired by the host that owns the manifest. */
export interface ApprovalControl {
  /** Everything approvable now, upstream first — the order approval has to happen in. */
  list(): Promise<Approvable[]>;
  /** Approve one. A refusal comes back as `ok: false` with the sentence the command would give. */
  approve(item: Approvable): Promise<{ ok: boolean; message: string }>;
  /**
   * The small model that reads the author's words, built by the host because it owns the keys and
   * knows whether this run is mocked. Async because resolving a key can fail, and it should fail
   * by name at the point of use rather than at session start. `null` is a host with no model for
   * this — a mocked session — and {@link offlineTriage} stands in.
   */
  triage(): Promise<ChatBackend | null>;
}

/** What the triage model is asked to decide. */
export interface ApprovalRequest {
  /** The author's own recent turns, oldest first. Nothing the agent wrote is in here. */
  said: readonly string[];
  /** Everything approvable right now. */
  assets: readonly Approvable[];
}

export const approvalTriageSchema = z.object({
  /** Whether the author asked for approval at all, in these words, recently. */
  asked: z.boolean(),
  /** One sentence quoting or paraphrasing what they said — shown to them on the card. */
  reason: z.string(),
  /** The hashes they meant, from the list and only from the list. */
  hashes: z.array(z.string()),
});

export type ApprovalTriage = z.infer<typeof approvalTriageSchema>;

const TRIAGE_SYSTEM = `You decide whether an author gave permission to approve generated artwork, and which pictures they meant.

You are shown two things: the author's own recent messages, verbatim, and the list of pictures that could be approved right now. You are not shown anything the assistant said, and you must not infer permission from the fact that you were asked — being asked is not evidence.

Answer with JSON only: {"asked": boolean, "reason": string, "hashes": string[]}.

- "asked" is true only if one of the author's messages asks, in its own words, for artwork to be approved or accepted. A message that merely praises a picture, asks to see one, or asks for one to be drawn is not asking for approval. When in doubt, answer false.
- "reason" is one short sentence saying what they asked for, quoting their words where you can. If "asked" is false, say what they did ask for instead.
- "hashes" holds the hashes of exactly the pictures their request covers, copied from the list. An unqualified request ("approve the art") covers every listed picture. A qualified one ("approve the location art", "approve Aiko's") covers only what matches. Never include a hash that is not in the list, and never include one the request does not cover. If "asked" is false, "hashes" is empty.`;

/** The author's words and the list, laid out for the triage model. */
export function triagePrompt(req: ApprovalRequest): string {
  const said = req.said.length
    ? req.said.map((line, i) => `[${i + 1}] ${line.trim()}`).join('\n\n')
    : '(the author has not said anything yet)';
  const assets = req.assets.length
    ? req.assets.map((a) => `${a.hash}  ${a.label}  [${a.kind}]  fills: ${a.slot}`).join('\n')
    : '(nothing is approvable)';
  return `The author's recent messages, oldest first:\n\n${said}\n\nThe pictures that could be approved right now:\n\n${assets}`;
}

/** Put the question to the triage model. The schema is the whole contract; nothing is parsed loosely. */
export async function triageApprovals(
  backend: ChatBackend,
  req: ApprovalRequest,
): Promise<ApprovalTriage> {
  const triage = await withStructuredRetry(approvalTriageSchema, () =>
    backend.message({ system: TRIAGE_SYSTEM, prompt: triagePrompt(req) }),
  );
  return narrowTriage(triage, req.assets);
}

/**
 * Keep only what was on the list, and drop everything if the answer was "they did not ask".
 *
 * Belt and braces over a model that was told both rules, because these two are the ones whose
 * failure is silent: a hallucinated hash that happens to match nothing is harmless, and one that
 * happens to match something is an approval nobody asked for.
 */
export function narrowTriage(
  triage: ApprovalTriage,
  assets: readonly Approvable[],
): ApprovalTriage {
  if (!triage.asked) return { ...triage, hashes: [] };
  const known = new Set(assets.map((a) => a.hash));
  return { ...triage, hashes: triage.hashes.filter((hash) => known.has(hash)) };
}

/**
 * The offline triage, for a mocked session. Deliberately dumb and deliberately honest about it:
 * it matches words, says so in `reason`, and is no weaker a gate than the real one because the
 * gate that actually protects the author is the card they confirm afterwards.
 */
export function offlineTriage(req: ApprovalRequest): ApprovalTriage {
  const asking = [...req.said]
    .reverse()
    .find((line) => /\b(approve|approving|accept|accepting|sign off)\b/i.test(line));
  if (!asking) {
    return {
      asked: false,
      reason: 'Nothing in the recent messages asks for artwork to be approved (matched offline).',
      hashes: [],
    };
  }
  const words = asking.toLowerCase();
  // A request that names nothing on the list covers all of it — the same rule the model is given.
  const named = req.assets.filter((a) => mentions(words, a));
  const covered = named.length ? named : req.assets;
  return {
    asked: true,
    reason: `Matched "${asking.trim().slice(0, 120)}" offline, without a model.`,
    hashes: covered.map((a) => a.hash),
  };
}

/** Whether a request's words single this picture out — its kind, its slot, or a word of its name. */
function mentions(words: string, asset: Approvable): boolean {
  if (words.includes(asset.kind)) return true;
  const parts = `${asset.label} ${asset.slot}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 2);
  return parts.some((part) => words.includes(part));
}

/**
 * The card the author reads before anything is written. Every picture by name, what its approval
 * would do, and the sentence the triage model gave for why it is on the list at all — because a
 * list of ten hashes with no account of where it came from is not something anyone can consent to.
 */
export function approvalCard(triage: ApprovalTriage, chosen: readonly Approvable[]): string {
  const rows = chosen.map((a) => {
    const door = a.door === 'gate' ? 'clears the character gate' : 'accepted for its slot';
    return `  • ${a.label} — ${door}`;
  });
  const one = chosen.length === 1;
  return (
    `Approve ${chosen.length} picture${one ? '' : 's'}?\n\n${rows.join('\n')}\n\n` +
    `Why these: ${triage.reason}`
  );
}
