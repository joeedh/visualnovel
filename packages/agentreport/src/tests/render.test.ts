import { renderReport, reportTitle, TITLE_PREFIX } from '../render.js';
import type { Report } from '../report.js';
import type { Evidence } from '../transcript.js';

const analysis = {
  summary: 'The agent rewrote a scene it was only asked to read',
  whatHappened: 'The author asked for a summary. The agent edited the file instead.',
  whatWentWrong: ['It treated a question as an instruction', 'It did not propose a plan first'],
  rootCause: 'A read request and an edit request are not distinguished in the prompt.',
  recommendations: [
    {
      behaviour: 'Never write in plan mode',
      where: 'loop.ts',
      rationale: 'Edits are undoable but trust is not',
    },
    {
      behaviour: 'Ask when the verb is ambiguous',
      rationale: 'One question costs less than one bad edit',
    },
  ],
  confidence: 'medium' as const,
  evidence: ['author: just tell me what happens in it'],
};

const report: Report = { analysis, model: 'claude-sonnet-5', readSource: true };

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  thread: {
    id: 't1',
    title: 'Scene 1 rewrite',
    startedAt: '2026-01-01T14:00:00.000Z',
    commit: 'abc1234',
    model: 'claude-haiku-4-5',
    items: [
      {
        id: 1,
        role: 'user',
        text: 'just tell me what happens in it',
        at: '2026-01-01T14:00:00.000Z',
      },
    ],
  },
  acts: [],
  thin: false,
  context: { appVersion: '1.2.3', effort: 'low' },
  ...over,
});

describe('the title', () => {
  it('carries the prefix a maintainer filters on', () => {
    expect(reportTitle(report)).toBe(`${TITLE_PREFIX} ${analysis.summary}`);
  });

  it('cuts a long summary rather than filing an unreadable one', () => {
    const long = { ...report, analysis: { ...analysis, summary: 'x'.repeat(400) } };
    const title = reportTitle(long, 60);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('flattens a summary the model wrote over two lines', () => {
    const wrapped = { ...report, analysis: { ...analysis, summary: 'it\n  rewrote a scene' } };
    expect(reportTitle(wrapped)).toBe(`${TITLE_PREFIX} it rewrote a scene`);
  });
});

describe('the body', () => {
  it('leads with the summary and says the report was redacted', () => {
    const body = renderReport(report, evidence());
    expect(body.startsWith(`## ${analysis.summary}`)).toBe(true);
    expect(body).toContain('pseudonyms');
  });

  it('states each recommendation as behaviour, with where it belongs', () => {
    const body = renderReport(report, evidence());
    expect(body).toContain('- **Never write in plan mode** (`loop.ts`)');
    expect(body).toContain('  - Why: Edits are undoable but trust is not');
    expect(body).toContain('- **Ask when the verb is ambiguous**\n  - Why:');
  });

  it('says so plainly when there are none, rather than showing an empty heading', () => {
    const none = { ...report, analysis: { ...analysis, recommendations: [] } };
    expect(renderReport(none, evidence())).toContain('The analyst had none to make.');
  });

  it('prints the author’s own words as the claim under test, above the analysis', () => {
    const said = { ...report, authorStatement: 'It kept rewriting Character A' };
    const body = renderReport(said, evidence());
    expect(body).toContain('### What the author reported');
    expect(body).toContain('> It kept rewriting Character A');
    expect(body.indexOf('### What the author reported')).toBeLessThan(
      body.indexOf('### What happened'),
    );
  });

  it('shows no heading at all when the author said nothing', () => {
    expect(renderReport({ ...report, authorStatement: '  ' }, evidence())).not.toContain(
      '### What the author reported',
    );
    expect(renderReport(report, evidence())).not.toContain('### What the author reported');
  });

  it('quotes the evidence as a blockquote', () => {
    expect(renderReport(report, evidence())).toContain('> author: just tell me what happens in it');
  });

  it('leaves out the sections it has nothing for', () => {
    const bare = {
      ...report,
      analysis: { ...analysis, whatWentWrong: [], evidence: [] },
    };
    const body = renderReport(bare, evidence());
    expect(body).not.toContain('### What went wrong');
    expect(body).not.toContain('### From the transcript');
  });

  it('says what analysed it, and whether it read the source', () => {
    const body = renderReport(report, evidence());
    expect(body).toContain('- Analysed by: claude-sonnet-5');
    expect(body).toContain('- Read the source: yes');
    expect(body).toContain('- The agent under report: claude-haiku-4-5');
    expect(body).toContain('- App version: 1.2.3');
  });

  it('admits a fallback instead of implying the source was read', () => {
    const fell = { ...report, readSource: false, fellBack: 'it never filed one' };
    const body = renderReport(fell, evidence());
    expect(body).toContain('- Read the source: no');
    expect(body).toContain('it never filed one');
  });

  it('warns that a thin transcript proves nothing by its silence', () => {
    expect(renderReport(report, evidence({ thin: true }))).toContain('not evidence of absence');
  });

  it('folds the conversation away at the end', () => {
    const body = renderReport(report, evidence());
    expect(body).toContain('<summary>The conversation, redacted</summary>');
    expect(body).toContain('# Conversation: Scene 1 rewrite');
    expect(body.indexOf('### Recommendations')).toBeLessThan(body.indexOf('<details>'));
  });
});
