/**
 * The guide reader, and the check that the shipped file is the shape the pane needs.
 *
 * The last test is the important one: it reads `docs/api-keys.md` itself. The structure that
 * file carries — a section per vendor, a yaml block of facts — exists for machines, and prose
 * being edited is exactly when a machine-readable part quietly stops being read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_VENDORS } from '@vn/config';
import { blockText } from '../markdown.js';
import { guideUrls, headingSlug, keyGuideProblems, parseKeyGuide } from '../apikeys.js';

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
      vendor: 'gemini',
      name: 'Google Gemini',
      console: 'https://example.test/console',
      env: 'GEMINI_API_KEY',
      freeTier: true,
    });
    // The yaml block is facts, not words: it is read and then it is gone.
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
      'No `## anthropic` section in docs/api-keys.md.',
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

describe('the shipped docs/api-keys.md', () => {
  // Five directories up from `src/shared/tests`: the repo root.
  const path = join(__dirname, '..', '..', '..', '..', '..', 'docs', 'api-keys.md');
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
