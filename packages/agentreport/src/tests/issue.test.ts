import {
  BODY_BUDGET,
  ISSUE_LABEL,
  ISSUE_REPO,
  URL_LIMIT,
  assertIssueUrl,
  fitBody,
  issueUrl,
} from '../issue.js';
import { renderReport } from '../render.js';
import type { Report } from '../report.js';
import type { Evidence } from '../transcript.js';

const report: Report = {
  analysis: {
    summary: 'The agent rewrote a scene it was only asked to read',
    whatHappened: 'The author asked for a summary. The agent edited the file instead.',
    whatWentWrong: ['It treated a question as an instruction'],
    rootCause: 'A read request and an edit request are not distinguished in the prompt.',
    recommendations: [
      {
        behaviour: 'Never write in plan mode',
        where: 'loop.ts',
        rationale: 'Trust is not undoable',
      },
    ],
    confidence: 'medium',
    evidence: ['author: just tell me what happens in it'],
  },
  model: 'claude-sonnet-5',
  readSource: true,
};

/** A conversation long enough that the folded transcript alone blows the budget. */
function evidence(turns: number): Evidence {
  return {
    thread: {
      id: 't1',
      title: 'Scene 1 rewrite',
      startedAt: '2026-01-01T14:00:00.000Z',
      items: Array.from({ length: turns }, (_, i) => ({
        id: i + 1,
        role: 'user' as const,
        text: `turn ${i + 1}: ${'the author said something at length. '.repeat(6)}`,
        at: '2026-01-01T14:00:00.000Z',
      })),
    },
    acts: [],
    thin: false,
    context: {},
  };
}

describe('fitting a report into a link', () => {
  it('leaves a short report exactly as it was', () => {
    const body = renderReport(report, evidence(1));
    const fitted = fitBody(body);
    expect(fitted.truncated).toBe(false);
    expect(fitted.body).toBe(body);
  });

  it('sheds the folded conversation first, and says the whole thing is on the clipboard', () => {
    const fitted = fitBody(renderReport(report, evidence(200)));
    expect(fitted.truncated).toBe(true);
    expect(fitted.body).not.toContain('<details>');
    expect(fitted.body).toContain('on your clipboard');
  });

  it('keeps what the issue is for, whatever else it has to drop', () => {
    const fitted = fitBody(renderReport(report, evidence(200)));
    expect(fitted.body).toContain('## The agent rewrote a scene it was only asked to read');
    expect(fitted.body).toContain('### Root cause');
    expect(fitted.body).toContain('### Recommendations');
    expect(fitted.body).toContain('- **Never write in plan mode** (`loop.ts`)');
    expect(fitted.body).toContain('### How this was analysed');
  });

  it('sheds sections in order once the transcript is gone', () => {
    // Small enough that dropping the transcript is not sufficient, large enough that it must
    // give up the quoted evidence and then the narrative to fit.
    const fitted = fitBody(renderReport(report, evidence(200)), 900);
    expect(fitted.body).not.toContain('### From the transcript');
    expect(fitted.body).not.toContain('### What happened');
    expect(fitted.body).toContain('### Recommendations');
  });

  it('never exceeds the budget it was given, even when every section is sheddable', () => {
    for (const limit of [3000, 900, 400, 200]) {
      const fitted = fitBody(renderReport(report, evidence(200)), limit);
      expect(encodeURIComponent(fitted.body).length).toBeLessThanOrEqual(limit);
    }
  });

  it('leaves room on the URL for the origin, the title and the label', () => {
    const long = { ...report, analysis: { ...report.analysis, summary: 'x'.repeat(120) } };
    const { body } = fitBody(renderReport(long, evidence(200)));
    const url = issueUrl({ title: `AGENTREPORT: ${'x'.repeat(120)}`, body });
    expect(url.toString().length).toBeLessThanOrEqual(URL_LIMIT);
    expect(BODY_BUDGET).toBeLessThan(URL_LIMIT);
  });
});

describe('the issue URL', () => {
  it('is the new-issue form of the repository fixed at build time', () => {
    const url = issueUrl({ title: 'AGENTREPORT: it rewrote a scene', body: 'hello' });
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe(`/${ISSUE_REPO}/issues/new`);
  });

  it('carries the title, the body and the label a maintainer filters on', () => {
    const url = issueUrl({ title: 'AGENTREPORT: x', body: '## report\n\nbody' });
    expect(url.searchParams.get('title')).toBe('AGENTREPORT: x');
    expect(url.searchParams.get('body')).toBe('## report\n\nbody');
    expect(url.searchParams.get('labels')).toBe(ISSUE_LABEL);
  });

  it('cannot be steered somewhere else by what the model wrote', () => {
    const url = issueUrl({ title: 'AGENTREPORT: x', body: 'https://evil.test/#' });
    expect(url.origin).toBe('https://github.com');
    expect(url.searchParams.get('body')).toBe('https://evil.test/#');
  });

  it('refuses a URL that is not that form', () => {
    expect(() =>
      assertIssueUrl(new URL('https://evil.test/joeedh/visualnovel/issues/new')),
    ).toThrow(/refusing to open/);
    expect(() => assertIssueUrl(new URL('https://github.com/joeedh/visualnovel/settings'))).toThrow(
      /refusing to open/,
    );
  });
});
