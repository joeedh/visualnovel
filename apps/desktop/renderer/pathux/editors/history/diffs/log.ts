/**
 * What a log's change says: how many lines were appended, and for the manifest, which slots hold
 * a different picture. A log is not shown line by line — every pipeline save touches one, and its
 * lines are the app's, not the author's.
 */
import type { Diff } from '../../../../../src/shared/history.js';

type LogDiff = Extract<Diff, { kind: 'log' }>;
type BinaryDiff = Extract<Diff, { kind: 'binary' }>;

function sentence(text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'hd-sentence';
  node.textContent = text;
  return node;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** How a log grew: one sentence, and for the manifest a row per slot whose picture moved. */
export function drawLog(diff: LogDiff): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hd-log';
  const grew = plural(diff.added, 'line');
  root.appendChild(
    sentence(
      diff.removed === 0
        ? `${grew} appended.`
        : `${grew} appended, ${plural(diff.removed, 'line')} rewritten.`,
    ),
  );
  if (diff.slots === undefined) return root;
  if (diff.slots.length === 0) {
    root.appendChild(sentence('No slot holds a different picture.'));
    return root;
  }
  root.appendChild(sentence(`${plural(diff.slots.length, 'slot')} hold a different picture:`));
  const list = document.createElement('div');
  list.className = 'hd-slots';
  for (const slot of diff.slots) {
    const row = document.createElement('div');
    row.className = 'hd-slot';
    const name = document.createElement('span');
    name.className = 'hd-slot-name';
    name.textContent = slot.slot;
    const move = document.createElement('span');
    move.className = 'hd-slot-move';
    move.textContent =
      slot.before === null
        ? `now ${slot.after?.slice(0, 8)}`
        : slot.after === null
          ? `was ${slot.before.slice(0, 8)}, now empty`
          : `${slot.before.slice(0, 8)} → ${slot.after.slice(0, 8)}`;
    row.append(name, move);
    list.appendChild(row);
  }
  root.appendChild(list);
  return root;
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Bytes git could not diff: their size either side. */
export function drawBinary(diff: BinaryDiff): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hd-log';
  const text =
    diff.before === null
      ? `Added, ${kb(diff.after ?? 0)}.`
      : diff.after === null
        ? `Removed, was ${kb(diff.before)}.`
        : `Binary, ${kb(diff.before)} → ${kb(diff.after)}.`;
  root.appendChild(sentence(text));
  return root;
}
