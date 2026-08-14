import { IDLE, canEdit, canGrab } from '../editing.js';

describe('the two modes over one grid', () => {
  it('lets either gesture start from rest', () => {
    expect(canEdit(IDLE)).toBe(true);
    expect(canGrab(IDLE)).toBe(true);
  });

  it('makes the script column inert mid-drag and the handles inert mid-edit', () => {
    expect(canEdit({ editing: null, dragging: true })).toBe(false);
    expect(canGrab({ editing: 's:L2', dragging: false })).toBe(false);
  });

  // Clicking another line while one is open is not a mode clash: the first editor blurs, which
  // commits it, and the second opens. Only the *other* gesture is locked out.
  it('lets a click move the editor from one line to another', () => {
    expect(canEdit({ editing: 's:L1', dragging: false })).toBe(true);
  });
});
