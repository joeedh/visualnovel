/**
 * The report as markdown — the body of the GitHub issue, and the thing the author reads and
 * edits before it is filed.
 *
 * One renderer for both analysis paths, so a report written after reading the source and one
 * written from the transcript alone are the same document with one line different. Pure: it is
 * handed a finished `Report` and finished `Evidence` and touches nothing.
 */
import type { Report } from './report.js';
import { toMarkdown, type Evidence } from './transcript.js';

/** The title, which the filer prefixes so a maintainer can find every one of these at once. */
export const TITLE_PREFIX = 'AGENTREPORT:';

/** A one-line title from the analysis, prefixed and trimmed to something a tab can hold. */
export function reportTitle(report: Report, max = 120): string {
  const line = report.analysis.summary.replace(/\s+/g, ' ').trim();
  const room = max - TITLE_PREFIX.length - 1;
  const cut = line.length > room ? `${line.slice(0, Math.max(1, room - 1)).trimEnd()}…` : line;
  return `${TITLE_PREFIX} ${cut}`;
}

const REDACTION_NOTE =
  'Names, paths and account names in this report were replaced before it was written: ' +
  'characters and locations are pseudonyms, and the substitution table was never saved. ' +
  'A pseudonym means the same thing everywhere in this report and nothing outside it.';

function bullets(items: string[]): string {
  return items.map((item) => `- ${item.replace(/\s*\n\s*/g, ' ').trim()}`).join('\n');
}

function quotes(items: string[]): string {
  return items
    .map((item) =>
      item
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
    )
    .join('\n>\n');
}

function recommendation(rec: Report['analysis']['recommendations'][number]): string {
  const where = rec.where ? ` (\`${rec.where}\`)` : '';
  return `- **${rec.behaviour}**${where}\n  - Why: ${rec.rationale}`;
}

/** How the report was arrived at, stated so a reader can weigh it. */
function provenance(report: Report, evidence: Evidence): string {
  const lines = [
    `- Analysed by: ${report.model}`,
    `- Confidence: ${report.analysis.confidence}`,
    `- Read the source: ${report.readSource ? 'yes' : 'no'}`,
  ];
  if (report.fellBack) {
    lines.push(`- The source was offered and not used: ${report.fellBack}`);
  }
  if (evidence.context.appVersion) lines.push(`- App version: ${evidence.context.appVersion}`);
  if (evidence.thread.commit) lines.push(`- Commit: ${evidence.thread.commit}`);
  if (evidence.thread.model) lines.push(`- The agent under report: ${evidence.thread.model}`);
  if (evidence.context.effort) lines.push(`- Effort: ${evidence.context.effort}`);
  if (evidence.thin) {
    lines.push(
      '- The transcript predates the detailed format, so tool calls recorded a name and ' +
        'nothing else. Absence of evidence below is not evidence of absence.',
    );
  }
  return lines.join('\n');
}

/**
 * The whole issue body. The transcript goes in a collapsed block at the end, because it is the
 * longest part and the recommendations are what a maintainer opened the issue for.
 */
export function renderReport(report: Report, evidence: Evidence): string {
  const { analysis } = report;
  const out = [
    `## ${analysis.summary.trim()}`,
    `_${REDACTION_NOTE}_`,
    '### What happened',
    analysis.whatHappened.trim(),
  ];

  if (analysis.whatWentWrong.length) {
    out.push('### What went wrong', bullets(analysis.whatWentWrong));
  }
  out.push('### Root cause', analysis.rootCause.trim());

  out.push(
    '### Recommendations',
    analysis.recommendations.length
      ? analysis.recommendations.map(recommendation).join('\n')
      : 'The analyst had none to make.',
  );

  if (analysis.evidence.length) out.push('### From the transcript', quotes(analysis.evidence));

  out.push('### How this was analysed', provenance(report, evidence));
  out.push(
    [
      '<details>',
      '<summary>The conversation, redacted</summary>',
      '',
      toMarkdown(evidence),
      '</details>',
    ].join('\n'),
  );

  return `${out.join('\n\n')}\n`;
}
