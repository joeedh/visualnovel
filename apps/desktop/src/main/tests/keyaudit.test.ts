/**
 * The half of the weekly audit that decides anything, tested without a network or a key.
 *
 * The cases that matter are the ones where the audit is being asked to say something it does not
 * know: a page it could not read, a reply about the wrong vendor, drift with no proposal. Each of
 * those has to come out as `could-not-check` rather than as a pass, because the whole value of a
 * weekly advisory run is that a green week means something.
 */
import {
  AUDIT_SYSTEM,
  MIN_PAGE_CHARS,
  auditPrompt,
  hasDrift,
  htmlToText,
  pageProblem,
  parseReview,
  renderReview,
  unreadable,
  type VendorReview,
} from '../keyaudit.js';

const PAGE = `<html><head><style>.a{color:red}</style><script>var x = "<p>lie</p>";</script></head>
<body><h1>Get an API key</h1><ol><li>Open the console.</li><li>Click <b>Create key</b>.</li></ol>
<p>Keys are secret &amp; must not be shared.</p></body></html>`;

describe('htmlToText', () => {
  const text = htmlToText(PAGE);

  it('keeps what a reader sees', () => {
    expect(text).toContain('Get an API key');
    expect(text).toContain('Click Create key');
  });

  it('drops script and style contents, including markup hiding inside them', () => {
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('lie');
  });

  it('decodes the entities that appear in prose, named and numeric alike', () => {
    expect(text).toContain('secret & must not be shared');
    // Both vendors serve hex escapes in shell snippets; left raw they read as noise.
    expect(htmlToText('<p>a &#x26;&#x26; b &#8212; c &#39;d&#39;</p>')).toBe("a && b — c 'd'");
  });

  it('leaves an entity it does not know as it was written', () => {
    expect(htmlToText('<p>50 &plusmn; 3</p>')).toBe('50 &plusmn; 3');
  });

  // Step order is most of what this audit compares, so a list flattened onto one line would be a
  // different document.
  it('keeps list items on separate lines', () => {
    expect(text).toContain('- Open the console.\n- Click Create key.');
  });

  it('leaves no runs of blank lines or doubled spaces behind', () => {
    expect(text).not.toMatch(/\n{3}| {2}/);
  });
});

describe('pageProblem', () => {
  it('passes a page with enough text to compare against', () => {
    expect(pageProblem('x'.repeat(MIN_PAGE_CHARS))).toBeUndefined();
  });

  // This exists for one failure: a single-page app served to a bare fetch is a loading shell, and
  // a model handed that would report drift against nothing.
  it('refuses a loading shell, saying what it got rather than that the docs changed', () => {
    const problem = pageProblem('Loading…');
    expect(problem).toContain('8 characters');
    expect(problem).toContain('rendered by script');
  });
});

describe('auditPrompt', () => {
  const prompt = auditPrompt({
    vendor: 'gemini',
    name: 'Google Gemini',
    ours: 'Open the console and press Create key.',
    pageUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    pageText: 'Get an API key. Click Get API key.',
  });

  it('names the vendor id the reply has to echo', () => {
    expect(prompt).toContain('Vendor id: gemini (Google Gemini)');
  });

  it('carries both sides and says which page theirs came from', () => {
    expect(prompt).toContain('Open the console and press Create key.');
    expect(prompt).toContain('Click Get API key.');
    expect(prompt).toContain('https://ai.google.dev/gemini-api/docs/api-key');
  });

  it('caps the page, so a weekly run cannot be priced by a vendor’s footer', () => {
    const huge = auditPrompt({
      vendor: 'gemini',
      name: 'Google Gemini',
      ours: 'ours',
      pageUrl: 'https://example.com',
      pageText: 'x'.repeat(200_000),
    });
    expect(huge.length).toBeLessThan(60_000);
  });

  it('tells the model that agreeing about an unread page is the worst answer', () => {
    expect(AUDIT_SYSTEM).toContain('could-not-check');
    expect(AUDIT_SYSTEM).toContain('worst answer available');
  });
});

describe('parseReview', () => {
  it('accepts an agreement, and drops the fields that only belong to drift', () => {
    const review = parseReview(
      { vendor: 'gemini', verdict: 'agree', summary: 'Same steps.', proposal: 'ignore me' },
      'gemini',
    );
    expect(review).toEqual({ vendor: 'gemini', verdict: 'agree', summary: 'Same steps.' });
  });

  it('keeps a drift report whole', () => {
    const review = parseReview(
      {
        vendor: 'anthropic',
        verdict: 'drifted',
        summary: 'The button was renamed.',
        ours: 'press Create key',
        theirs: 'press Create Key',
        proposal: '3. Press **Create Key**.',
      },
      'anthropic',
    );
    expect(review.verdict).toBe('drifted');
    expect(review.proposal).toBe('3. Press **Create Key**.');
  });

  // The two sections are structurally identical, so a swapped reply reads as a plausible review
  // of the wrong file — which is worse than no review.
  it('refuses a reply about a different vendor rather than filing it', () => {
    const review = parseReview({ vendor: 'gemini', verdict: 'agree', summary: 'ok' }, 'anthropic');
    expect(review).toEqual(unreadable('anthropic', 'the model answered about gemini instead'));
  });

  // Drift with nothing to apply is a complaint, and the plan asks for a proposal a person could
  // paste as-is.
  it('refuses drift that proposes no replacement', () => {
    const review = parseReview(
      { vendor: 'gemini', verdict: 'drifted', summary: 'Something changed.', proposal: '  ' },
      'gemini',
    );
    expect(review.verdict).toBe('could-not-check');
    expect(review.summary).toContain('proposed no replacement');
  });

  it('throws on a reply that is not the shape asked for', () => {
    expect(() => parseReview({ vendor: 'gemini', verdict: 'maybe' }, 'gemini')).toThrow();
  });
});

describe('renderReview', () => {
  const agreed: VendorReview = { vendor: 'gemini', verdict: 'agree', summary: 'Same steps.' };
  const drifted: VendorReview = {
    vendor: 'anthropic',
    verdict: 'drifted',
    summary: 'The key page moved.',
    ours: 'Open Settings ▸ API keys.',
    theirs: 'Open Developer ▸ Keys.',
    proposal: '2. Open **Developer ▸ Keys**.',
  };

  it('opens with nothing to apply when nothing moved', () => {
    const md = renderReview([agreed], '2026-08-18');
    expect(md).toContain('**Nothing to apply.** 1 of 1 vendor sections still match');
    expect(md).toContain('Run 2026-08-18.');
  });

  it('leads with the count when something moved, and says nothing was changed', () => {
    const md = renderReview([agreed, drifted], '2026-08-18');
    expect(md).toContain('**1 of 2 vendor sections look out of date.**');
    expect(md).toContain('Nothing has been changed');
  });

  it('quotes both sides and fences the proposal so it can be pasted', () => {
    const md = renderReview([drifted], '2026-08-18');
    expect(md).toContain('> Open Settings ▸ API keys.');
    expect(md).toContain('> Open Developer ▸ Keys.');
    expect(md).toContain('```markdown\n2. Open **Developer ▸ Keys**.\n```');
  });

  // An unread page must not disappear into a green summary.
  it('says how many could not be read, and that it is not the same as being fine', () => {
    const md = renderReview([agreed, unreadable('anthropic', 'a sign-in wall answered')], '2026');
    expect(md).toContain('**Nothing to apply.** 1 of 2 vendor sections still match');
    expect(md).toContain('1 could not be read at all, which is not the same as being fine');
    expect(md).toContain('## anthropic — could not be checked');
  });

  // This prevents one report: every page failed to load and the top line reads as a clean week.
  // A run that looked at nothing has to say so in its first sentence.
  it('never reports a pass for a week in which nothing was checked', () => {
    const md = renderReview(
      [unreadable('gemini', 'timed out'), unreadable('anthropic', 'no key')],
      '2026',
    );
    expect(md).toContain('**Nothing was checked.**');
    expect(md).toContain('says nothing about whether they are still right');
    expect(md).not.toContain('Nothing to apply');
  });

  it('repeats the one rule, in the file a person will be reading', () => {
    expect(renderReview([agreed], '2026')).toContain('never writes to it');
  });
});

describe('hasDrift', () => {
  it('is true only for drift — an unread page is not a change to apply', () => {
    expect(hasDrift([{ vendor: 'a', verdict: 'agree', summary: '' }])).toBe(false);
    expect(hasDrift([unreadable('a', 'no')])).toBe(false);
    expect(hasDrift([{ vendor: 'a', verdict: 'drifted', summary: '', proposal: 'x' }])).toBe(true);
  });
});
