/**
 * Paths as prose writes them: relative to the document they sit in, forward-slashed, with no
 * scheme. A link or a picture written this way is what a markdown viewer over the same checkout
 * follows, and these two functions are the whole of the arithmetic between that form and the
 * workspace-relative paths the rest of the app names documents by.
 */

/** The path from the directory of `docPath` to `file`, both workspace-relative. */
export function relativePath(docPath: string, file: string): string {
  const from = dirOf(docPath);
  const to = file.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}

/**
 * The workspace-relative path an `href` written in `docPath` names, or `undefined` for a url,
 * an absolute path, or a path climbing out of the workspace.
 */
export function resolvePath(docPath: string, href: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return undefined;
  const parts = dirOf(docPath);
  for (const part of href.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function dirOf(docPath: string): string[] {
  const parts = docPath.split('/');
  parts.pop();
  return parts.filter((p) => p !== '');
}
