/** What every `report.*` command that needs a live conversation refuses with when there is none. */
export const NO_REPORT = 'No debug conversation is open.';

/** What `report.say` refuses with while a turn is in flight. `report.stop` is accepted instead. */
export const REPORT_BUSY = 'The analyst is still answering.';

/**
 * The refusal message for a report that still contains redacted names. It names only the first
 * leak: the author fixes them one at a time and the scan re-runs on every keystroke, so listing
 * all of them would produce sentences that go stale as soon as the first edit lands.
 */
export function leakSentence(leaked: readonly string[]): string {
  const rest = leaked.length - 1;
  const more = rest > 0 ? ` (and ${rest} other${rest === 1 ? '' : 's'})` : '';
  return `“${leaked[0]}”${more} is still in the report — take it out before filing.`;
}
