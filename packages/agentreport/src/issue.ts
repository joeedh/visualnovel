/**
 * The report as a GitHub issue URL: where it is filed, what fits in a link, and the check that the
 * link is the one intended.
 *
 * This is pure and lives in the package rather than in the app because none of it depends on the
 * host. Opening the URL does depend on the host, and that stays in main where `shell.openExternal`
 * lives.
 */

/**
 * The repository issues are filed against, fixed at build time rather than read from the git
 * remote. A packaged app has no checkout to read one from, and a contributor's fork would point at
 * the fork, where nobody would see the report.
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
 * What the issue form is prefilled with. The report itself goes on the clipboard, so the author
 * does the same thing every time rather than learning a length limit that changes what they have
 * to do.
 */
export const PASTE_BODY = 'paste report here (it should be in your clipboard)';

/**
 * Refuses a URL that is not the new-issue form. The body is text a model wrote, and a composed
 * string must never reach `shell.openExternal` unchecked.
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
