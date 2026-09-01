/**
 * The map a tour plans against, read from what `scripts/sweep-anchors.mjs` measured.
 *
 * Planning happens before any pane is open, so nothing drawn can answer "where does
 * `prompt.condense` live". The sweep's records can, and they are measurements rather than
 * declarations: a control that stopped being drawn stops appearing here at the next sweep.
 *
 * A command the file does not name resolves `unanchored`, which is a true statement about a
 * project that was never swept as well as about a command no pane draws. Either way the palette
 * is the floor, so the answer the author gets is the same.
 */
import sweep from '../../anchors.json';
import { mapOf, type AnchorHome, type AnchorMap, type AnchorRecord } from './anchors.js';

/** How the sweep writes a record. Widened here because JSON carries no union types. */
interface SweptRecord {
  id: string;
  editor: string;
  supplies?: string[];
  form?: boolean;
}

const records: AnchorRecord[] = (sweep.records as SweptRecord[]).map((record) => ({
  id: record.id,
  editor: record.editor as AnchorHome,
  ...(record.supplies ? { supplies: record.supplies } : {}),
  ...(record.form ? { form: true } : {}),
}));

export const ANCHOR_MAP: AnchorMap = mapOf(records);

/** When the map was measured, and against which build. Shown by `tour.explain`. */
export const SWEPT = { at: sweep.sweptAt as string, sha: sweep.gitSha as string };
