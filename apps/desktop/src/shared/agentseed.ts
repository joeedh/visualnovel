/**
 * The openers a surface hands the composer: the sentence a right-clicked script line and a failed
 * asset start a conversation with.
 *
 * Pure and shared, so `agent.editLine` and `agent.fixAsset` can be checked without a project on
 * disk. The composer is a single-line field, so an opener is one line with no newlines in it.
 */
import type { AssetInfo, SceneCoverage } from './ipc.js';

/** The opener quotes up to this many characters of somebody else's words before eliding the rest. */
const QUOTED = 90;

/** One line, whitespace collapsed, cut at `max` characters. */
function elide(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The opener for one line of a scene. It carries three addresses because each is read by somebody
 * different: the number is what the author clicked, the id is what a `story.*` refusal names, and
 * the words are what identifies the line once the agent has the scene open.
 *
 * The number counts lines from the heading, which is what `scriptRows` puts in the gutter. It
 * shifts as soon as a line is inserted, which is why the id travels beside it.
 *
 * Answers an empty string when the scene holds no such line, so a menu built before an edit
 * arrived opens nothing.
 */
export function lineOpener(scene: SceneCoverage, lineId: string): string {
  const at = scene.lines.findIndex((l) => l.id === lineId);
  if (at < 0) return '';
  const line = scene.lines[at]!;
  const said = line.speaker ? `${line.speaker}: ${line.text}` : line.text;
  return `In scene ${scene.sceneId}, line ${at + 1} (${lineId}) — “${elide(said, QUOTED)}” — `;
}

/**
 * The opener for an asset the pipeline gave up on. A whole request rather than a stub, because the
 * author clicked a button on a failure they have already read: the turn they are one keystroke from
 * sending has to be the one they meant.
 *
 * The retry budget is quoted for a fault only, the same distinction `failureNote` draws in
 * `renderer/rules/assetview.ts` — a `needs_human` frame records one attempt per refine pass, and
 * none of them counts against the budget.
 *
 * Answers an empty string for an asset that has not failed, which is the case `agent.fixAsset`
 * refuses.
 */
export function assetOpener(info: AssetInfo): string {
  const failure = info.failure;
  if (!failure) return '';
  const named = info.slot ? `“${info.label}” (${info.slot})` : `“${info.label}”`;
  const subject = failure.later ? `The re-render of ${named}` : named;
  const gave =
    failure.status === 'failed'
      ? `failed after ${failure.attempts} of ${failure.maxAttempts} attempts`
      : 'was drawn, and review kept blocking it';
  const why = failure.error ? ` — ${elide(failure.error, QUOTED)}` : '';
  return (
    `${subject} ${gave}${why}. Work out what in its prompt or its art notes caused that, ` +
    'and propose a change.'
  );
}
