/**
 * What renaming a document means, as text in and text out.
 *
 * A rename changes the name the document is drawn under, and where that name lives depends on what
 * the document is. A character or a location sheet is named by front-matter `name:` — the field
 * the model reads, wherever the sheet is filed. Everything else is named by its title, which
 * `@vn/bible` takes from front-matter `title:`, then the first H1, then the filename stem. A
 * rename writes wherever the title was read from, or the tree would go on showing the old name and
 * the rename would look like it failed.
 *
 * It never moves the file. An id is derived from a name once, at creation; afterwards it is what
 * shots, cast lists and `[[goto:]]` markers point at, and renaming the file would break every one
 * of them silently.
 *
 * These functions are pure and are tested that way. The write itself is
 * `WorkspaceSession.renameDoc`, over the same `writeDocFile` every other document save goes
 * through.
 */
import { applyCharacterEdit, applyLocationEdit, docToMarkdown } from '@vn/model';
import { parseFrontMatter, splitFrontMatter } from '@vn/parse';
import { conventionalKind, taggedKind } from '@vn/store';

export type RenameResult =
  /** `what` names the field that changed, for the sentence a check and a record report. */
  { ok: true; text: string; what: string } | { ok: false; reason: string };

/** The first top-level `title:` entry in a front-matter block, and its value. */
const TITLE_LINE = /^title:[^\n]*(?:\n[ \t]+[^\n]*)*\n?/m;

/** Matches an ATX H1 (`# Something`) on its own line, not `##`, which marks a section. */
const H1_LINE = /^#[ \t]+[^\n]*/m;

/** Splice `text` around one match, leaving every other byte where it was. */
function spliceAt(text: string, at: number, length: number, replacement: string): string {
  return text.slice(0, at) + replacement + text.slice(at + length);
}

/**
 * Rewrite a document so it is known by `name`. `path` is workspace-relative and decides only
 * whether a conventional home makes this an entity sheet, falling back to a `type:` tag — the same
 * order `checkDocWrite` asks in.
 */
export function renameInText(path: string, text: string, name: string): RenameResult {
  const next = name.trim();
  if (!next) return { ok: false, reason: 'A name cannot be blank.' };

  const doc = parseFrontMatter(text);
  const kind = conventionalKind(path) ?? taggedKind(doc.data);

  if (kind) {
    const applied =
      kind === 'character'
        ? applyCharacterEdit(doc, { name: next })
        : applyLocationEdit(doc, { name: next });
    if (!applied.ok) return { ok: false, reason: applied.diagnostic.message };
    return { ok: true, text: docToMarkdown(applied.value.doc), what: `the ${kind}'s name` };
  }

  const { prefix, body } = splitFrontMatter(text);

  // Front-matter `title:` wins for the bible, so it wins here — spliced rather than re-serialized,
  // because a wiki page's YAML is the author's and re-emitting it would reflow keys they ordered.
  const title = TITLE_LINE.exec(prefix);
  if (title) {
    const entry = `title: ${JSON.stringify(next)}${title[0].endsWith('\n') ? '\n' : ''}`;
    return {
      ok: true,
      text: spliceAt(prefix, title.index, title[0].length, entry) + body,
      what: 'the page title',
    };
  }

  const heading = H1_LINE.exec(body);
  if (heading) {
    return {
      ok: true,
      text: prefix + spliceAt(body, heading.index, heading[0].length, `# ${next}`),
      what: 'the page heading',
    };
  }

  // The page is titled by its filename and nothing else, and the file does not move, so the name
  // has to go into the text. A heading at the top is how a page with no title reads best.
  const head = prefix === '' ? '' : `${prefix}\n`;
  const rest = body.replace(/^\n+/, '');
  return { ok: true, text: `${head}# ${next}\n${rest ? `\n${rest}` : ''}`, what: 'a heading' };
}
