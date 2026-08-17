/**
 * The report as a GitHub issue URL: where it is filed, what fits in a link, and the assertion
 * that the link is the one we meant to open.
 *
 * Pure and in the package rather than in the app, because none of it depends on the host — but
 * *opening* the URL does, and that stays in main where `shell.openExternal` lives.
 */

/**
 * The repository issues are filed against, fixed at build time rather than read from the git
 * remote. A packaged app has no checkout to read one from, and a contributor's fork points at the
 * fork — a report filed there is a report nobody sees.
 */
export const ISSUE_REPO = 'joeedh/visualnovel';

/** What a maintainer filters on, alongside the title prefix. */
export const ISSUE_LABEL = 'agent-report';

const ISSUE_ORIGIN = 'https://github.com';
const ISSUE_PATH = `/${ISSUE_REPO}/issues/new`;

/**
 * Roughly what GitHub will accept as a whole URL. Past it the request is rejected outright rather
 * than truncated, so the author gets an error page instead of a form.
 */
export const URL_LIMIT = 8000;

/**
 * What is left for the body once the origin, the path, a full-length title and the label are on
 * the URL. Percent-encoding inflates markdown badly — a newline is three characters, a backtick
 * three, an em dash nine — so this is a much smaller document than the number suggests.
 */
export const BODY_BUDGET = 6000;

const TRIMMED_NOTE =
  '_This report was trimmed to fit a link. The full report, including the redacted ' +
  'conversation, is on your clipboard — paste it in below._';

/**
 * Sections shed to make a report fit, least load-bearing first. The summary, the root cause, the
 * recommendations and the provenance are never shed: they are what the issue is for, and an issue
 * that arrives without them is worse than one that arrives trimmed.
 */
const SHEDDABLE = ['From the transcript', 'What happened', 'What went wrong'] as const;

/** What a string costs as a query-parameter value — the only length that matters here. */
function cost(text: string): number {
  return encodeURIComponent(text).length;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drop the folded conversation. It is by far the largest part and never survives a trim. */
function withoutTranscript(body: string): string {
  return body.replace(/\n*<details>[\s\S]*?<\/details>\s*$/, '\n').trimEnd();
}

/** Drop one `###` section, heading and all, up to the next heading or the end. */
function withoutSection(body: string, heading: string): string {
  const pattern = new RegExp(`\\n*### ${escapeRe(heading)}\\n[\\s\\S]*?(?=\\n### |$)`);
  return body.replace(pattern, '').trimEnd();
}

/**
 * The longest prefix that fits. Encoded length is monotonic in the prefix, so a binary search
 * lands on it without encoding the whole document once per character.
 */
function shrink(text: string, budget: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd();
}

/**
 * The report, cut down to something a URL will carry, and whether anything was lost.
 *
 * A `truncated` body ends with a line telling the author the whole thing is on their clipboard —
 * which is the caller's job to have put there, and the reason the note is worded as an
 * instruction rather than an apology.
 */
export function fitBody(report: string, limit = BODY_BUDGET): { body: string; truncated: boolean } {
  if (cost(report) <= limit) return { body: report, truncated: false };

  const note = `\n\n${TRIMMED_NOTE}\n`;
  const budget = Math.max(0, limit - cost(note));

  let kept = withoutTranscript(report);
  for (const heading of SHEDDABLE) {
    if (cost(kept) <= budget) break;
    kept = withoutSection(kept, heading);
  }
  if (cost(kept) > budget) kept = shrink(kept, budget);

  // The budget is a promise, so a limit too small even for the note takes the note down with it.
  const body = `${kept}${note}`;
  return { body: cost(body) <= limit ? body : shrink(body, limit), truncated: true };
}

/**
 * Refuse a URL that is not the new-issue form. The body is text a model wrote, and a composed
 * string must never reach `shell.openExternal` on trust — this is where that trust is checked.
 */
export function assertIssueUrl(url: URL): void {
  if (url.origin !== ISSUE_ORIGIN || url.pathname !== ISSUE_PATH) {
    throw new Error(
      `refusing to open ${url.origin}${url.pathname} — an agent report is filed at ` +
        `${ISSUE_ORIGIN}${ISSUE_PATH} and nowhere else`,
    );
  }
}

/** The prefilled new-issue URL, asserted before it is handed back. */
export function issueUrl(input: { title: string; body: string; labels?: readonly string[] }): URL {
  const url = new URL(ISSUE_PATH, ISSUE_ORIGIN);
  url.searchParams.set('title', input.title);
  url.searchParams.set('body', input.body);

  const labels = input.labels ?? [ISSUE_LABEL];
  if (labels.length > 0) url.searchParams.set('labels', labels.join(','));

  assertIssueUrl(url);
  return url;
}
