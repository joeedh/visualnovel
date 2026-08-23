import {
  ISSUE_LABEL,
  ISSUE_REPO,
  PASTE_BODY,
  URL_LIMIT,
  assertIssueUrl,
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

describe('the prefilled body', () => {
  it('is the paste instruction, whatever the report is', () => {
    // The report itself never travels on the URL, so a conversation of any length fits and the
    // author does the same thing every time.
    expect(PASTE_BODY).toContain('clipboard');
    const url = issueUrl({ title: 'AGENTREPORT: x', body: PASTE_BODY });
    expect(url.searchParams.get('body')).toBe(PASTE_BODY);
  });

  it('leaves room on the URL for the origin, a long title and the label', () => {
    const long = { ...report, analysis: { ...report.analysis, summary: 'x'.repeat(120) } };
    // Rendered so the test still fails if a report ever reaches the URL again
    expect(renderReport(long, evidence(200)).length).toBeGreaterThan(URL_LIMIT);
    const url = issueUrl({ title: `AGENTREPORT: ${'x'.repeat(120)}`, body: PASTE_BODY });
    expect(url.toString().length).toBeLessThanOrEqual(URL_LIMIT);
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
