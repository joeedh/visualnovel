import { WRITE_PENDING } from '../busy.js';
import { GRAB_BLOCKED, IDLE, canEdit, canGrab, grabRefusal } from '../editing.js';

describe('the modes over one grid', () => {
  it('lets either gesture start from rest', () => {
    expect(canEdit(IDLE)).toBe(true);
    expect(canGrab(IDLE)).toBe(true);
  });

  it('makes the script column inert mid-drag and the handles inert mid-edit', () => {
    expect(canEdit({ editing: null, dragging: true, pending: false })).toBe(false);
    expect(canGrab({ editing: 's:L2', dragging: false, pending: false })).toBe(false);
  });

  // Clicking another line while one is open is not a mode clash: the first editor blurs, which
  // commits it, and the second opens. Only the *other* gesture is locked out.
  it('lets a click move the editor from one line to another', () => {
    expect(canEdit({ editing: 's:L1', dragging: false, pending: false })).toBe(true);
  });

  it('locks both gestures while a write is in flight', () => {
    const pending = { editing: null, dragging: false, pending: true };
    expect(canEdit(pending)).toBe(false);
    expect(canGrab(pending)).toBe(false);
  });

  it('names the write, not the editor, when both locks apply', () => {
    expect(grabRefusal({ editing: 's:L1', dragging: false, pending: true })).toBe(WRITE_PENDING);
    expect(grabRefusal({ editing: 's:L1', dragging: false, pending: false })).toBe(GRAB_BLOCKED);
  });
});
