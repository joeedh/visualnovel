/**
 * The guide reader, and the check that the shipped file is the shape the pane needs.
 *
 * One of these blocks reads `docs/guides/api-keys.md` itself. The structure that file carries
 * — a section per vendor, a yaml block of facts — exists for machines, and an edit to the prose
 * around it is what most often breaks a machine-readable part without anyone noticing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_VENDORS } from '@vn/config';
import { blockText } from '../markdown.js';
import {
  canaryFor,
  guideUrls,
  headingSlug,
  keyGuideProblems,
  linkReport,
  linkVerdict,
  parseKeyGuide,
  siteOf,
} from '../apikeys.js';

const GUIDE = `# Getting an API key

<!-- toc -->

- [Gemini](#gemini)

<!-- tocstop -->

You need both.

## Gemini

\`\`\`yaml
vendor: gemini
name: Google Gemini
console: https://example.test/console
docs: https://example.test/docs
billing: https://example.test/billing
env: GEMINI_API_KEY
freeTier: true
\`\`\`

1. Open it.
2. Copy the key.

## Where a key goes

The first of these that has one.
`;

describe('parseKeyGuide', () => {
  const guide = parseKeyGuide(GUIDE);

  it('reads a vendor section into facts and steps', () => {
    expect(guide.vendors).toHaveLength(1);
    const gemini = guide.vendors[0]!;
    expect(gemini).toMatchObject({
      vendor  : 'gemini',
      name    : 'Google Gemini',
      console : 'https://example.test/console',
      env     : 'GEMINI_API_KEY',
      freeTier: true,
    });
    // The yaml block is read for its facts and then dropped from the body
    expect(gemini.body.some((block) => block.kind === 'code')).toBe(false);
    expect(gemini.body.map((block) => blockText(block))).toEqual(['Open it.\nCopy the key.']);
  });

  it('keeps the intro, and the sections after the vendors, without the generated contents', () => {
    expect(guide.intro.map((block) => blockText(block))).toEqual(['You need both.']);
    expect(guide.notes).toEqual([
      { title: 'Where a key goes', body: [expect.objectContaining({ kind: 'para' })] },
    ]);
  });

  it('slugs a heading the way an anchor does', () => {
    expect(headingSlug('Gemini')).toBe('gemini');
    expect(headingSlug('Where a key goes')).toBe('where-a-key-goes');
  });

  it('lists every URL with the vendor and field it came from', () => {
    expect(guideUrls(guide)).toEqual([
      { vendor: 'gemini', field: 'console', url: 'https://example.test/console' },
      { vendor: 'gemini', field: 'docs', url: 'https://example.test/docs' },
      { vendor: 'gemini', field: 'billing', url: 'https://example.test/billing' },
    ]);
  });
});

describe('keyGuideProblems', () => {
  it('names a vendor with no section', () => {
    const guide = parseKeyGuide(GUIDE);
    expect(keyGuideProblems(guide, ['gemini', 'anthropic'])).toEqual([
      'No `## anthropic` section in docs/guides/api-keys.md.',
    ]);
  });

  it('names a section that lost a fact, rather than reporting the page as fine', () => {
    const guide = parseKeyGuide(GUIDE.replace('console: https://example.test/console\n', ''));
    expect(keyGuideProblems(guide, ['gemini'])).toEqual(['gemini: `console` is not an https URL.']);
  });

  it('is quiet about the page it is given when nothing is missing', () => {
    expect(keyGuideProblems(parseKeyGuide(GUIDE), ['gemini'])).toEqual([]);
  });
});

describe('the shipped docs/guides/api-keys.md', () => {
  // Five directories up from `src/shared/tests`: the repo root.
  const path = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'guides', 'api-keys.md');
  const guide = parseKeyGuide(readFileSync(path, 'utf8'));

  it('has a section per vendor, in KEY_VENDORS order, with every fact the pane draws', () => {
    expect(keyGuideProblems(guide, KEY_VENDORS)).toEqual([]);
    expect(guide.vendors.map((vendor) => vendor.vendor)).toEqual([...KEY_VENDORS]);
  });

  it('says what each vendor charges, because neither vendor’s own page does', () => {
    expect(guide.vendors.find((vendor) => vendor.vendor === 'gemini')!.freeTier).toBe(true);
    expect(guide.vendors.find((vendor) => vendor.vendor === 'anthropic')!.freeTier).toBe(false);
  });

  it('names the environment variables `project.yaml` defaults to', () => {
    expect(guide.vendors.map((vendor) => vendor.env)).toEqual([
      'GEMINI_API_KEY',
      'ANTHROPIC_API_KEY',
    ]);
  });
});

describe('linkVerdict', () => {
  const CONSOLE = 'https://aistudio.google.com/apikey';

  it('passes a page that answered from where it was asked', () => {
    expect(linkVerdict(CONSOLE, { status: 200, finalUrl: CONSOLE })).toEqual({
      ok    : true,
      detail: 'HTTP 200',
    });
  });

  // Being signed out sends the key console to Google's own login. That is the page working rather
  // than the page having moved, so without this the check would fail every run
  it('allows a redirect that stays on the same site', () => {
    const signin = 'https://accounts.google.com/v3/signin/identifier?continue=' + CONSOLE;
    expect(linkVerdict(CONSOLE, { status: 200, finalUrl: signin }).ok).toBe(true);
  });

  // `ai.google.dev` appends a locale from where the request came from, so CI and a laptop see
  // different final URLs for one page.
  it('ignores a query string the vendor added', () => {
    const docs = 'https://ai.google.dev/gemini-api/docs/api-key';
    expect(linkVerdict(docs, { status: 200, finalUrl: docs + '?hl=th' }).ok).toBe(true);
  });

  it('fails a redirect that leaves the site, and says where it went', () => {
    const verdict = linkVerdict(CONSOLE, { status: 200, finalUrl: 'https://example.com/apikey' });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('https://example.com/apikey');
  });

  // A deleted deep link usually 301s to the front page and answers 200, so the status alone
  // cannot tell that from the page still being there.
  it('fails a deep link that landed on the site root', () => {
    const verdict = linkVerdict(CONSOLE, { status: 200, finalUrl: 'https://aistudio.google.com/' });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('site root');
  });

  it('accepts a root URL that stayed at the root', () => {
    const verdict = linkVerdict('https://claude.com/', {
      status  : 200,
      finalUrl: 'https://claude.com/',
    });
    expect(verdict.ok).toBe(true);
  });

  it('fails on a non-2xx status, naming it', () => {
    expect(linkVerdict(CONSOLE, { status: 404, finalUrl: CONSOLE })).toEqual({
      ok    : false,
      detail: 'HTTP 404',
    });
  });

  it('fails when nothing answered, and repeats what went wrong', () => {
    expect(linkVerdict(CONSOLE, { error: 'getaddrinfo ENOTFOUND' })).toEqual({
      ok    : false,
      detail: 'getaddrinfo ENOTFOUND',
    });
  });

  it('fails a URL it cannot read at all rather than treating it as a site', () => {
    expect(linkVerdict('not a url', { status: 200, finalUrl: 'not a url' }).ok).toBe(false);
  });
});

describe('siteOf', () => {
  it('reduces a host to its last two labels', () => {
    expect(siteOf('https://platform.claude.com/settings/keys')).toBe('claude.com');
    expect(siteOf('https://ai.google.dev/gemini-api/docs/api-key')).toBe('google.dev');
  });

  it('is empty for something that is not a URL, so a comparison cannot pass by accident', () => {
    expect(siteOf('keys/gemini.txt')).toBe('');
  });
});

describe('linkReport', () => {
  const CONSOLE = 'https://aistudio.google.com/apikey';
  const DOCS = 'https://ai.google.dev/gemini-api/docs/api-key';

  const answered = (url: string, status = 200) => ({ status, finalUrl: url });

  it('asks about a sibling path that cannot exist', () => {
    expect(canaryFor(CONSOLE)).toBe('https://aistudio.google.com/apikey/vn-link-check-canary');
  });

  it('drops the query, so the canary is not a page the vendor might actually serve', () => {
    expect(canaryFor(DOCS + '?hl=th')).toBe(DOCS + '/vn-link-check-canary');
  });

  it('is ok when the host says no to the canary and yes to the page', () => {
    const report = linkReport(DOCS, answered(DOCS), answered(canaryFor(DOCS), 404));
    expect(report).toEqual({ state: 'ok', detail: 'HTTP 200' });
  });

  // Every path under the Gemini console answers 200 from Google's login (including the one a
  // broken link would have) so the 200 is worth nothing on its own
  it('is unverified when the host answers everything', () => {
    const signin = 'https://accounts.google.com/v3/signin/identifier';
    const report = linkReport(CONSOLE, answered(signin), answered(signin));
    expect(report.state).toBe('unverified');
    expect(report.detail).toContain('a path that cannot exist');
  });

  it('is broken when the page itself failed, whatever the canary did', () => {
    const report = linkReport(DOCS, answered(DOCS, 404), answered(canaryFor(DOCS), 404));
    expect(report).toEqual({ state: 'broken', detail: 'HTTP 404' });
  });

  // A canary request that failed must not turn a good page into an unverified one
  it('trusts the page when the canary request itself failed', () => {
    const report = linkReport(DOCS, answered(DOCS), { error: 'socket hang up' });
    expect(report.state).toBe('ok');
  });
});
