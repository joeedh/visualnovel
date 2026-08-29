/**
 * Tier 2 of [`docs/plans/archive/INDEX.md#auditing-the-api-key-instructions`]: whether the wording in
 * `docs/guides/api-keys.md` still describes what a vendor's own page says today.
 *
 * Tier 1 (`scripts/check-key-links.mjs`) answers whether the links resolve, which is a fact.
 * This answers whether the walkthrough beside them is still true, which is a judgement — so it
 * runs weekly rather than per-commit, proposes rather than edits, and never fails a build. A
 * model comparing prose to prose across pages that get reworded constantly will be wrong some of
 * the time, and a blocking check that is wrong some of the time is one people learn to override.
 *
 * The pure half lives here so it can be tested without a network or a key. Fetching and the model
 * call are in `scripts/audit-key-instructions.mjs`, and every decision is made by a function
 * below. Nothing here writes. The audit's one hard rule is that `docs/guides/api-keys.md` is
 * edited by a person, because it is what a new user reads when they are least able to tell that
 * something is wrong.
 *
 * This file is deliberately not imported by `index.ts`. It reasons about the desktop app's key
 * guide, which is why it lives here, but the app never runs it and it is not in the bundle.
 */
import { z } from 'zod';

/** What the audit concluded about one vendor's section. */
export const VERDICTS = ['agree', 'drifted', 'could-not-check'] as const;

export type Verdict = (typeof VERDICTS)[number];

export const VendorReviewSchema = z.object({
  /** The `KEY_VENDORS` id, echoed back so a reply cannot be silently attached to the wrong one. */
  vendor: z.string(),
  verdict: z.enum(VERDICTS),
  /** One sentence a person can act on without opening the vendor's page. */
  summary: z.string(),
  /** What our file says, quoted, where it drifted. */
  ours: z.string().optional(),
  /** What the vendor's page says instead, quoted. */
  theirs: z.string().optional(),
  /** The replacement wording, ready to paste. Empty unless `drifted`. */
  proposal: z.string().optional(),
});

export type VendorReview = z.infer<typeof VendorReviewSchema>;

/**
 * A page the audit could not read, and why.
 *
 * `could-not-check` is a first-class verdict rather than a swallowed error. A page behind JS
 * rendering or a bot wall cannot be read at all, and reporting "agree" about such a page would
 * read exactly like a pass while being false.
 */
export function unreadable(vendor: string, why: string): VendorReview {
  return { vendor, verdict: 'could-not-check', summary: why };
}

/** Elements whose contents are markup or data rather than anything a reader sees. */
const INVISIBLE = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** `&#38;` and `&#x26;` both appear in these pages, and a raw `&#x26;` reads as noise. */
const NUMERIC = /^#(x)?([0-9a-f]+)$/i;

/**
 * The visible words of an HTML page, near enough for a model to read.
 *
 * Deliberately not a parser. What is being compared is a walkthrough — "open this page, click
 * Create key, copy it" — and every wording of that survives losing the markup. Both vendor pages
 * are also framework-rendered, so a real parse would buy fidelity on a structure that is mostly
 * navigation chrome anyway.
 *
 * Block-level tags become newlines rather than nothing, because a numbered list collapsed into
 * one line reads as a different document, and step order is most of what this audit is checking.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(INVISIBLE, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
      // `li` is absent on purpose: `<li>` below already opens its own line, and closing one
      // too would put a blank line between every step.
      .replace(/<\/(?:p|div|tr|ul|ol|table|h[1-6]|section|article|pre|blockquote)\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(#?[a-z0-9]+);/gi, (whole, name) => {
        const numeric = NUMERIC.exec(name);
        if (numeric) return String.fromCodePoint(parseInt(numeric[2] ?? '', numeric[1] ? 16 : 10));
        return ENTITIES[String(name).toLowerCase()] ?? whole;
      })
      .replace(/[ \t\f\v\u00a0]+/g, ' ')
      // An inline tag becomes a space, so without this `<b>Create key</b>.` would read as
      // "Create key ." and the model would have to decide to ignore the gap
      .replace(/ +([.,;:!?)\]])/g, '$1')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * How much readable text a page must have before the audit is willing to judge it.
 *
 * A single-page app served to a bare fetch is a few hundred characters of loading shell, and a
 * model handed that will confidently report that our instructions no longer match, having
 * compared them against nothing. The floor distinguishes a page the vendor rewrote from a page
 * that was never read.
 */
export const MIN_PAGE_CHARS = 2000;

/**
 * A model prompt is priced by the token, and the tail of one of these pages is footer links.
 * The cap holds a whole walkthrough while keeping a weekly run's cost to cents.
 */
export const MAX_PAGE_CHARS = 40_000;

/** Why this page cannot be compared, or `undefined` if it can. */
export function pageProblem(text: string): string | undefined {
  if (text.length < MIN_PAGE_CHARS) {
    return (
      `the page returned only ${text.length} characters of readable text, below the ` +
      `${MIN_PAGE_CHARS} needed to compare against — it is rendered by script, or something ` +
      'answered in its place'
    );
  }
  return undefined;
}

export const AUDIT_SYSTEM = [
  'You are auditing one page of onboarding documentation for drift.',
  '',
  'The author maintains their own short walkthrough telling a new user how to create an API key',
  "for a vendor. You are given that walkthrough and the text of the vendor's own current page.",
  'Decide whether the walkthrough would still work today.',
  '',
  'Report `agree` unless a user following the walkthrough would be stopped or misled. A button',
  'renamed, a step reordered, a page moved, a free tier withdrawn, a required step that is now',
  'missing — those are `drifted`. Different wording for the same act is not; neither is our',
  'walkthrough being shorter than theirs, which it is meant to be.',
  '',
  "Report `could-not-check` if the page text you were given is not the vendor's documentation —",
  'a sign-in wall, an error, a loading shell, or a page about something else. Saying `agree`',
  'about a page you could not read is the worst answer available.',
  '',
  'Where you report `drifted`, `proposal` must be the replacement text for our walkthrough,',
  'written in its voice and ready to paste in with no editing. Quote what each side says in',
  '`ours` and `theirs` so a person can check you without opening anything.',
  '',
  'Reply with one JSON object and nothing else:',
  '{"vendor": string, "verdict": "agree" | "drifted" | "could-not-check", "summary": string,',
  ' "ours": string, "theirs": string, "proposal": string}',
].join('\n');

/** The one question, for one vendor. */
export function auditPrompt(opts: {
  vendor: string;
  name: string;
  ours: string;
  pageUrl: string;
  pageText: string;
}): string {
  return [
    `Vendor id: ${opts.vendor} (${opts.name})`,
    '',
    'Our walkthrough, from docs/guides/api-keys.md:',
    '---',
    opts.ours,
    '---',
    '',
    `The vendor's own page, ${opts.pageUrl}, as text:`,
    '---',
    opts.pageText.slice(0, MAX_PAGE_CHARS),
    '---',
  ].join('\n');
}

/**
 * Validates one reply and holds it to the vendor it was asked about.
 *
 * A model that answers about the wrong vendor causes real harm here, because the two sections are
 * structurally identical, so a swapped reply would read as a plausible review of the wrong file.
 */
export function parseReview(raw: unknown, vendor: string): VendorReview {
  const review = VendorReviewSchema.parse(raw);
  if (review.vendor !== vendor) {
    return unreadable(vendor, `the model answered about ${review.vendor || 'no vendor'} instead`);
  }
  if (review.verdict !== 'drifted')
    return { ...review, ours: undefined, theirs: undefined, proposal: undefined };
  if (!review.proposal?.trim()) {
    return unreadable(vendor, 'the model reported drift but proposed no replacement wording');
  }
  return review;
}

/** Whether this run has anything a person has to act on. */
export function hasDrift(reviews: readonly VendorReview[]): boolean {
  return reviews.some((review) => review.verdict === 'drifted');
}

const HEADLINE: Record<Verdict, string> = {
  agree: 'still matches',
  drifted: 'has drifted',
  'could-not-check': 'could not be checked',
};

/**
 * The review, as the markdown that becomes both the artifact and the issue body.
 *
 * Written so the top line is readable in a notification: whoever gets this is deciding in one
 * glance whether to open it, and every week that nothing moved they should be able to tell
 * without scrolling.
 */
export function renderReview(reviews: readonly VendorReview[], stamp: string): string {
  const drifted = reviews.filter((r) => r.verdict === 'drifted');
  const agreed = reviews.filter((r) => r.verdict === 'agree');
  const unchecked = reviews.filter((r) => r.verdict === 'could-not-check');

  const lines: string[] = ['# API key instructions — weekly review', '', `Run ${stamp}.`, ''];

  // The first line is the whole report for anyone reading a notification, so it must never say
  // "nothing to do" about a week when nothing was read. A run where every page failed to load
  // looks most like a pass, so it gets a headline of its own.
  if (drifted.length > 0) {
    lines.push(
      `**${drifted.length} of ${reviews.length} vendor sections look out of date.** Nothing has ` +
        'been changed — the proposed wording below is for a person to apply.',
    );
  } else if (agreed.length === 0) {
    lines.push(
      `**Nothing was checked.** None of the ${reviews.length} vendor sections could be read this ` +
        'week, so this run says nothing about whether they are still right.',
    );
  } else {
    lines.push(
      `**Nothing to apply.** ${agreed.length} of ${reviews.length} vendor sections still match ` +
        "their vendor's page.",
    );
  }

  if (unchecked.length > 0 && agreed.length > 0) {
    lines.push(
      '',
      `${unchecked.length} could not be read at all, which is not the same as being fine.`,
    );
  }

  for (const review of reviews) {
    lines.push('', `## ${review.vendor} — ${HEADLINE[review.verdict]}`, '', review.summary);
    if (review.verdict !== 'drifted') continue;
    if (review.ours) lines.push('', 'We say:', '', `> ${review.ours.split('\n').join('\n> ')}`);
    if (review.theirs) {
      lines.push('', 'They say:', '', `> ${review.theirs.split('\n').join('\n> ')}`);
    }
    lines.push(
      '',
      'Proposed replacement for that part of `docs/guides/api-keys.md`:',
      '',
      '```markdown',
    );
    lines.push(review.proposal ?? '');
    lines.push('```');
  }

  lines.push(
    '',
    '---',
    '',
    'Written by `scripts/audit-key-instructions.mjs`. It reads `docs/guides/api-keys.md` and never ' +
      'writes to it — apply what you agree with by hand, and close this when you have.',
  );
  return lines.join('\n') + '\n';
}
