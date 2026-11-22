import { characterFromDoc, locationFromDoc } from '@vn/model';
import type { FrontMatterDoc } from '@vn/parse';
import { conventionalKind, docKind, type GuardedWriters } from '@vn/store';

/** The command namespaces that own the guarded directories, named in a whole-file save's refusal. */
export const DOC_WRITERS: GuardedWriters = { scenes: 'story.*', graphs: 'gengraph.*' };

/**
 * What the model will make of a document that has already been saved — a diagnostic sentence, or
 * nothing. The kind comes from `docKind`, the rule entity discovery uses, so a tag that disagrees
 * with the directory is reported as the conflict discovery would raise rather than validated as
 * either kind. A note is not checked.
 */
export function entityDiagnostic(path: string, doc: FrontMatterDoc): string | undefined {
  const kind = docKind(conventionalKind(path), doc.data);
  if (kind.kind === 'note') return undefined;
  if (kind.kind === 'conflict') return `${path} ${kind.reason}`;
  const res = kind.kind === 'character' ? characterFromDoc(doc) : locationFromDoc(doc);
  return res.ok ? undefined : res.diagnostic.message;
}
