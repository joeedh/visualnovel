/**
 * Parser for `docs/guides/api-keys.md`.
 *
 * The walkthrough for getting a model key exists once, as that file, and three things read it:
 * the Setup pane, the docs site, and (later) a CI check that the vendor links still resolve. The
 * file therefore carries structure the prose does not need — an H2 per vendor whose slug is the
 * vendor id, and a fenced yaml block of the facts a machine should check — and this module is the
 * only reader of that structure.
 *
 * It is in `shared/` because main reads the file and the renderer draws it: the parse happens
 * once, on the side that has a filesystem, and what crosses the IPC boundary is already blocks.
 */
import { parseMarkdown, type Block } from './markdown.js';

/** The facts a vendor's yaml block states. Every field is required; a missing one is a problem. */
export interface KeyGuideVendor {
  /** The slug of the section's H2, which is also the `KEY_VENDORS` id. */
  vendor: string;
  /** The vendor's own name for itself, for a heading. */
  name: string;
  /** Where a key is created. */
  console: string;
  /** The vendor's own documentation for the same walkthrough. */
  docs: string;
  /** What using it costs. */
  billing: string;
  /** The environment variable `project.yaml` names by default. */
  env: string;
  /** Whether anything can be done without paying. */
  freeTier: boolean;
  /** The steps, below the yaml block. */
  body: Block[];
}

/** A section with no vendor yaml block: the shared advice below the vendor sections. */
export interface KeyGuideNote {
  title: string;
  body: Block[];
}

export interface KeyGuide {
  /** Everything above the first vendor section. */
  intro: Block[];
  vendors: KeyGuideVendor[];
  notes: KeyGuideNote[];
}

/** The fields of a vendor block that are URLs — what a link check has to visit. */
export const GUIDE_URL_FIELDS = ['console', 'docs', 'billing'] as const;

/** One field of `GUIDE_URL_FIELDS`. Their URLs are the only pages the app will hand to the OS. */
export type GuideUrlField = (typeof GUIDE_URL_FIELDS)[number];

/**
 * The heading-anchor slug GitHub and every docs renderer agree on, for the subset of headings
 * this file has: lowercase, punctuation dropped, spaces hyphenated. `## Gemini` slugs to `gemini`,
 * which is how a section is found by the vendor id listed in `KEY_VENDORS`.
 */
export function headingSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/** A generated table of contents is not part of the page a pane shows. */
const TOC_RE = /<!--\s*toc\s*-->[\s\S]*?<!--\s*tocstop\s*-->/g;
const H2_RE = /^##\s+(.+)$/;

/**
 * Parses the strict subset of yaml the vendor blocks are written in: one `key: value` per line,
 * scalars only, no quoting, no nesting.
 *
 * Deliberately not a yaml library. The block is a fixed set of five strings and a boolean, and a
 * permissive parse would accept a shape the pane cannot draw. An unrecognised line is skipped, and
 * {@link keyGuideProblems} then names the missing field.
 */
function parseFacts(text: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) facts[match[1]!] = match[2]!.trim();
  }
  return facts;
}

/** Split a document into its leading matter and its H2 sections, in file order. */
function sections(markdown: string): { intro: string; parts: { title: string; body: string }[] } {
  // Normalizes line endings before the split. `parseMarkdown` normalizes its own input, but this
  // split runs first, so on a CRLF copy of the file every heading kept a trailing carriage return
  // and no section was recognised as a vendor's, leaving the Setup pane with no vendors in it.
  const lines = markdown.replace(/\r\n?/g, '\n').replace(TOC_RE, '').split('\n');
  const intro: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];

  for (const line of lines) {
    const heading = H2_RE.exec(line);
    if (heading) parts.push({ title: heading[1]!.trim(), lines: [] });
    else (parts[parts.length - 1]?.lines ?? intro).push(line);
  }

  return {
    intro: intro.join('\n'),
    parts: parts.map((part) => ({ title: part.title, body: part.lines.join('\n') })),
  };
}

/**
 * Reads the guide. Every section is kept whichever shape it is in — a vendor section missing its
 * yaml block still comes back, with empty facts, so the pane draws a broken page rather than
 * nothing while the fix is written.
 */
export function parseKeyGuide(markdown: string): KeyGuide {
  const { intro, parts } = sections(markdown);
  const vendors: KeyGuideVendor[] = [];
  const notes: KeyGuideNote[] = [];
  let seenVendor = false;

  for (const part of parts) {
    const blocks = parseMarkdown(part.body);
    const fence = blocks.find((block) => block.kind === 'code' && block.lang === 'yaml');
    if (!fence) {
      // Once the vendors have started, an ordinary section is shared advice. A section before the
      // first vendor is still front matter, so it stays with the intro.
      if (seenVendor) notes.push({ title: part.title, body: blocks });
      continue;
    }

    seenVendor = true;
    const facts = parseFacts(fence.kind === 'code' ? fence.text : '');
    vendors.push({
      vendor  : facts['vendor'] ?? headingSlug(part.title),
      name    : facts['name'] ?? part.title,
      console : facts['console'] ?? '',
      docs    : facts['docs'] ?? '',
      billing : facts['billing'] ?? '',
      env     : facts['env'] ?? '',
      freeTier: facts['freeTier'] === 'true',
      body    : blocks.filter((block) => block !== fence),
    });
  }

  // Drops the page's own H1. The pane already shows the page title, so drawing both repeats it.
  const preface = parseMarkdown(intro);
  const opener = preface[0]?.kind === 'heading' && preface[0].level === 1 ? 1 : 0;
  return { intro: preface.slice(opener), vendors, notes };
}

/**
 * What is wrong with the guide, in sentences a person can act on. Every check is about the file
 * rather than the world. A link that 404s is CI's job. A link the file never states is this
 * function's.
 *
 * `expected` is `KEY_VENDORS`, passed in rather than imported so this stays free of `@vn/config`
 * and therefore of node — `shared/` is in the browser bundle.
 */
export function keyGuideProblems(guide: KeyGuide, expected: readonly string[]): string[] {
  const problems: string[] = [];
  const found = new Set(guide.vendors.map((vendor) => vendor.vendor));

  for (const vendor of expected) {
    if (!found.has(vendor))
      problems.push(`No \`## ${vendor}\` section in docs/guides/api-keys.md.`);
  }
  for (const vendor of guide.vendors) {
    if (!expected.includes(vendor.vendor)) {
      problems.push(
        `docs/guides/api-keys.md has a section for \`${vendor.vendor}\`, which is not a vendor.`,
      );
    }
    for (const field of GUIDE_URL_FIELDS) {
      if (!/^https:\/\/\S+$/.test(vendor[field])) {
        problems.push(`${vendor.vendor}: \`${field}\` is not an https URL.`);
      }
    }
    if (vendor.env === '') problems.push(`${vendor.vendor}: no \`env\` in its yaml block.`);
    if (vendor.body.length === 0) problems.push(`${vendor.vendor}: the section has no steps.`);
  }
  return problems;
}

/** Every URL the guide states, with the vendor and field it came from — the link check's list. */
export function guideUrls(guide: KeyGuide): { vendor: string; field: string; url: string }[] {
  return guide.vendors.flatMap((vendor) =>
    GUIDE_URL_FIELDS.filter((field) => vendor[field] !== '').map((field) => ({
      vendor: vendor.vendor,
      field,
      url: vendor[field],
    })),
  );
}

/**
 * The site a URL belongs to: its last two labels, so `aistudio.google.com` and
 * `accounts.google.com` are the same place and `platform.claude.com` is not.
 *
 * This is an approximation of the registrable domain, and it is wrong for a multi-label public
 * suffix (`example.co.uk` reduces to `co.uk`). That is fine for what it is used for — comparing
 * the two ends of one redirect, where both sides reduce the same way — and a real public-suffix
 * list is a dependency and a monthly update for no gain here.
 */
export function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.split('.').slice(-2).join('.');
  } catch {
    return '';
  }
}

/** What asking for one of the guide's URLs produced, or why nothing did. */
export interface LinkOutcome {
  /** The status of the final response, when one arrived. */
  status?: number;
  /** Where the request finished after redirects — `response.url`. */
  finalUrl?: string;
  /** Why no response arrived at all. */
  error?: string;
}

/**
 * Whether a link is still good, given what asking for it produced. Three ways to fail:
 *
 * - a non-2xx status, or no response at all;
 * - a redirect that leaves the site, rather than merely the host.
 *   `https://aistudio.google.com/apikey` answers 200 from `accounts.google.com` for anyone not
 *   signed in, which is the page working as intended; a check that called that a failure would
 *   fail every run and be switched off within a month. It still catches the failure that matters:
 *   a vendor moving its key console somewhere else entirely.
 * - a redirect to the site's own root. A deep link whose page was deleted usually 301s to the
 *   front page and answers 200, which a status alone cannot tell from the page still being there.
 *
 * A query string is not a change: `ai.google.dev` appends `?hl=<locale>` based on where the
 * request came from, so CI in one region and a laptop in another see different final URLs for one
 * intact page.
 */
export function linkVerdict(url: string, outcome: LinkOutcome): { ok: boolean; detail: string } {
  if (outcome.error !== undefined) return { ok: false, detail: outcome.error };
  const status = outcome.status ?? 0;
  if (status < 200 || status > 299) return { ok: false, detail: `HTTP ${status}` };

  const finalUrl = outcome.finalUrl ?? url;
  if (siteOf(finalUrl) !== siteOf(url) || siteOf(url) === '') {
    return { ok: false, detail: `redirected off ${siteOf(url)} to ${finalUrl}` };
  }

  const asked = new URL(url).pathname.replace(/\/+$/, '');
  let landed: string;
  try {
    landed = new URL(finalUrl).pathname.replace(/\/+$/, '');
  } catch {
    return { ok: false, detail: `answered with an unreadable URL: ${finalUrl}` };
  }
  if (landed === '' && asked !== '') {
    return { ok: false, detail: `redirected to the site root (${finalUrl})` };
  }

  return { ok: true, detail: `HTTP ${status}` };
}

/** How a link can turn out. `unverified` is a real answer, not a softened failure. */
export type LinkState = 'ok' | 'broken' | 'unverified';

/**
 * A sibling path of `url` that cannot exist, used to check whether a host ever answers a failure.
 *
 * Deterministic rather than random, so a run that reported something can be repeated by hand from
 * its own output.
 */
export function canaryFor(url: string): string {
  const canary = new URL(url);
  canary.pathname = canary.pathname.replace(/[/]+$/, '') + '/vn-link-check-canary';
  canary.search = '';
  canary.hash = '';
  return canary.toString();
}

/**
 * The verdict for one guide URL, given what it answered together with what a path that cannot
 * exist answered from the same host.
 *
 * The canary is why this is not just {@link linkVerdict}. `aistudio.google.com` is a single-page
 * app behind a sign-in: every path under it answers 200 from Google's login, including
 * `/apikey-moved-last-year`. Taking that 200 as proof would report the key console as fine for as
 * long as Google keeps the domain, including after the console has moved. So the check also asks
 * for a path it knows should not exist, and when the host answers 200 to that as well it reports
 * only what it learned: the host is up.
 *
 * `unverified` is deliberately not a failure. Whether a vendor puts its console behind a sign-in is
 * not a fact about our file, and failing on it would make this a check people switch off.
 */
export function linkReport(
  url: string,
  outcome: LinkOutcome,
  canary: LinkOutcome,
): { state: LinkState; detail: string } {
  const verdict = linkVerdict(url, outcome);
  if (!verdict.ok) return { state: 'broken', detail: verdict.detail };
  if (linkVerdict(canaryFor(url), canary).ok) {
    return {
      state : 'unverified',
      detail:
        `${verdict.detail}, but so does a path that cannot exist — the host answers ` +
        `everything, so this proves only that it is up`,
    };
  }
  return { state: 'ok', detail: verdict.detail };
}
