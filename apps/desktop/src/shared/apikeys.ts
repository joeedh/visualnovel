/**
 * `docs/api-keys.md`, read.
 *
 * The walkthrough for getting a model key exists once, as that file, and three things read it:
 * the Setup pane, the docs site, and (later) a CI check that the vendor links still resolve. So
 * the file carries a little structure the prose does not need — an H2 per vendor whose slug is
 * the vendor id, and a fenced yaml block of the facts a machine should check — and this is the
 * one reader of that structure.
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

/** A section that is not a vendor — the shared advice below them. */
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

/** One of them. The whole set of pages the app is willing to hand the OS. */
export type GuideUrlField = (typeof GUIDE_URL_FIELDS)[number];

/**
 * The heading-anchor slug GitHub and every docs renderer agree on, for the subset of headings
 * this file has: lowercase, punctuation dropped, spaces hyphenated. `## Gemini` is `gemini`,
 * which is what makes a section findable by the id `KEY_VENDORS` already orders.
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
 * The strict subset of yaml the vendor blocks are written in: one `key: value` per line, scalars
 * only, no quoting, no nesting.
 *
 * Not a yaml library, on purpose. The block is a fixed set of five strings and a boolean, and a
 * permissive parse would accept a shape the pane cannot draw; this refuses by returning nothing
 * for a line it does not recognise, and {@link keyGuideProblems} then names the missing field.
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
  const lines = markdown.replace(TOC_RE, '').split('\n');
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
 * Read the guide. Every section is kept whichever shape it is in — a vendor section missing its
 * yaml block still comes back, with empty facts, because the pane showing a broken page beats
 * the pane showing nothing while the fix is written.
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
      // Once the vendors have started, an ordinary section is shared advice. Before them it is
      // still front matter, so it stays with the intro rather than being lost.
      if (seenVendor) notes.push({ title: part.title, body: blocks });
      continue;
    }

    seenVendor = true;
    const facts = parseFacts(fence.kind === 'code' ? fence.text : '');
    vendors.push({
      vendor: facts['vendor'] ?? headingSlug(part.title),
      name: facts['name'] ?? part.title,
      console: facts['console'] ?? '',
      docs: facts['docs'] ?? '',
      billing: facts['billing'] ?? '',
      env: facts['env'] ?? '',
      freeTier: facts['freeTier'] === 'true',
      body: blocks.filter((block) => block !== fence),
    });
  }

  // The page's own H1 is its title, and a pane already has one — drawing both would put the
  // page's name inside a window that just said it.
  const preface = parseMarkdown(intro);
  const opener = preface[0]?.kind === 'heading' && preface[0].level === 1 ? 1 : 0;
  return { intro: preface.slice(opener), vendors, notes };
}

/**
 * What is wrong with the guide, in sentences a person can act on. Every check is about the file
 * rather than the world: a link that 404s is CI's job, and a link that is missing is this one's.
 *
 * `expected` is `KEY_VENDORS`, passed in rather than imported so this stays free of `@vn/config`
 * and therefore of node — `shared/` is in the browser bundle.
 */
export function keyGuideProblems(guide: KeyGuide, expected: readonly string[]): string[] {
  const problems: string[] = [];
  const found = new Set(guide.vendors.map((vendor) => vendor.vendor));

  for (const vendor of expected) {
    if (!found.has(vendor)) problems.push(`No \`## ${vendor}\` section in docs/api-keys.md.`);
  }
  for (const vendor of guide.vendors) {
    if (!expected.includes(vendor.vendor)) {
      problems.push(
        `docs/api-keys.md has a section for \`${vendor.vendor}\`, which is not a vendor.`,
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
