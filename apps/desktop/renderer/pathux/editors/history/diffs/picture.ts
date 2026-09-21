/**
 * A picture's change. Added: the picture. Removed: the old one greyed, with the word. Replaced:
 * both, stacked, with a wipe handle that answers a drag — the one motion in the pane. The bytes
 * come from `vngit://`, which serves any blob of any save, so a picture the store no longer
 * holds still draws.
 */
import type { Diff } from '../../../../../src/shared/history.js';

type PictureDiff = Extract<Diff, { kind: 'picture' }>;

/** Where the wipe starts, as a fraction of the width: the new take mostly showing. */
const WIPE_AT = 0.5;

function picture(url: string, alt: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'hd-picture';
  img.src = url;
  img.alt = alt;
  img.draggable = false;
  return img;
}

function caption(text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'hd-caption';
  node.textContent = text;
  return node;
}

export function drawPicture(diff: PictureDiff): HTMLElement {
  const root = document.createElement('div');
  root.className = 'hd-pictures';
  if (diff.before !== null && diff.after !== null) {
    root.appendChild(wipe(diff.before, diff.after));
    root.appendChild(caption('Drag the handle to compare the old take with the new one.'));
  } else if (diff.after !== null) {
    root.appendChild(picture(diff.after, 'The picture this save added'));
    root.appendChild(caption('Added'));
  } else if (diff.before !== null) {
    const gone = picture(diff.before, 'The picture this save removed');
    gone.classList.add('removed');
    root.appendChild(gone);
    root.appendChild(caption('Removed'));
  }
  return root;
}

/**
 * The old take under the new one, the new one clipped at the handle. The handle follows the
 * pointer while it is held, and the clip follows the handle, so nothing is animated on its own.
 */
function wipe(before: string, after: string): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'hd-wipe';
  const old = picture(before, 'The take before this save');
  const now = picture(after, 'The take after this save');
  now.classList.add('over');
  const handle = document.createElement('div');
  handle.className = 'hd-wipe-handle';
  handle.title = 'Drag to wipe between the old take and the new one.';
  frame.append(old, now, handle);

  const setAt = (fraction: number) => {
    const at = Math.min(1, Math.max(0, fraction));
    now.style.clipPath = `inset(0 0 0 ${at * 100}%)`;
    handle.style.left = `${at * 100}%`;
  };
  setAt(WIPE_AT);

  const follow = (event: PointerEvent) => {
    const box = frame.getBoundingClientRect();
    if (box.width > 0) setAt((event.clientX - box.left) / box.width);
  };
  frame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    frame.setPointerCapture(event.pointerId);
    follow(event);
    event.preventDefault();
  });
  frame.addEventListener('pointermove', (event) => {
    if (frame.hasPointerCapture(event.pointerId)) follow(event);
  });
  return frame;
}
