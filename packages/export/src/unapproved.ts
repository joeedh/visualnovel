/**
 * The refusal a host prints before it publishes a playable that would show unapproved takes. The
 * host lists the takes itself (`unapprovedTakes` in `@vn/stills`) and passes the list in, since
 * which take a slot holds and whether anyone approved it are the stills family's rules.
 */

/**
 * Answers the refusal for the first unapproved take in `takes`, or `undefined` when there is none.
 * Each entry is a slot address and the hash of the take it holds.
 */
export function unapprovedSentence(
  takes: readonly { readonly slot: string; readonly hash: string }[],
): string | undefined {
  const first = takes[0];
  if (!first) return undefined;
  const more = takes.length > 1 ? ` and ${takes.length - 1} more` : '';
  return `${first.slot} holds a take nobody has approved (${first.hash.slice(0, 8)}…)${more}. Accept it, or put an approved take back, before exporting.`;
}
