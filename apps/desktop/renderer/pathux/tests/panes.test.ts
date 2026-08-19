import {
  NO_PANE,
  paneClosable,
  paneElsewhere,
  paneShowing,
  paneToClose,
  paneToShowIn,
  paneToUse,
  type Pane,
} from '../panes.js';

const pane = (editor: string, over: Partial<Pane> = {}): Pane => ({
  editor,
  chrome: false,
  floating: false,
  active: false,
  width: 400,
  height: 400,
  ...over,
});

const header = pane('header', { chrome: true, height: 34 });

describe('which pane an editor is in', () => {
  test('is the one showing it', () => {
    expect(paneShowing([header, pane('script'), pane('convo')], 'convo')).toBe(2);
  });

  test('is nowhere when nothing shows it', () => {
    expect(paneShowing([header, pane('script')], 'timeline')).toBe(NO_PANE);
  });

  test('never answers the header, whatever it is called', () => {
    expect(paneShowing([pane('script', { chrome: true }), pane('script')], 'script')).toBe(1);
  });
});

describe('which pane an open lands in', () => {
  test('the active one', () => {
    const panes = [header, pane('script'), pane('convo', { active: true })];
    expect(paneToUse(panes)).toBe(2);
  });

  test('the biggest, when the pointer is over the header', () => {
    const panes = [
      pane('header', { chrome: true, active: true, height: 34 }),
      pane('script', { width: 300 }),
      pane('convo', { width: 900 }),
    ];
    expect(paneToUse(panes)).toBe(2);
  });

  test('nowhere at all when the mesh is only chrome', () => {
    expect(paneToUse([header])).toBe(NO_PANE);
  });
});

describe('which pane an editor is put in', () => {
  test('the active one, when the author is not reading a conversation', () => {
    const panes = [header, pane('script', { active: true }), pane('convo')];
    expect(paneToShowIn(panes)).toBe(1);
  });

  test('somewhere else when the active pane is a conversation', () => {
    const panes = [header, pane('script', { width: 300 }), pane('convo', { active: true })];
    expect(paneToShowIn(panes)).toBe(1);
  });

  test('the biggest that is not a conversation, when the pointer is over chrome', () => {
    const panes = [
      pane('header', { chrome: true, active: true, height: 34 }),
      pane('script', { width: 300 }),
      pane('convo', { width: 900 }),
    ];
    expect(paneToShowIn(panes)).toBe(1);
  });

  test('the conversation after all, when it is the only pane there is', () => {
    const panes = [header, pane('convo', { active: true })];
    expect(paneToShowIn(panes)).toBe(1);
  });

  test('nowhere at all when the mesh is only chrome', () => {
    expect(paneToShowIn([header])).toBe(NO_PANE);
  });
});

describe('which pane an open lands in when it must not land here', () => {
  test('the biggest other one', () => {
    const panes = [header, pane('documents', { width: 260 }), pane('script', { width: 900 })];
    expect(paneElsewhere(panes, 1)).toBe(2);
  });

  test('never the asking pane, even when it is the biggest', () => {
    const panes = [header, pane('documents', { width: 900 }), pane('script', { width: 300 })];
    expect(paneElsewhere(panes, 1)).toBe(2);
  });

  test('never chrome, so a header does not count as somewhere else', () => {
    expect(paneElsewhere([header, pane('documents')], 1)).toBe(NO_PANE);
  });

  test('nowhere when the asking pane is the only one — the caller splits instead', () => {
    expect(paneElsewhere([pane('documents')], 0)).toBe(NO_PANE);
  });

  test('steps around a conversation, even when the conversation is the biggest', () => {
    const panes = [header, pane('documents'), pane('convo', { width: 900 }), pane('script')];
    expect(paneElsewhere(panes, 1)).toBe(3);
  });

  test('lands in the conversation when it is the only other pane', () => {
    expect(paneElsewhere([header, pane('documents'), pane('convo')], 1)).toBe(2);
  });
});

describe('which pane a close collapses', () => {
  test('the active one, when there is somewhere to collapse into', () => {
    const panes = [header, pane('script', { active: true }), pane('convo')];
    expect(paneToClose(panes)).toBe(1);
  });

  test('none, because the last pane is kept', () => {
    expect(paneToClose([header, pane('script', { active: true })])).toBe(NO_PANE);
  });
});

describe('whether a picked pane may be closed', () => {
  test('an ordinary pane may, when it is not the last', () => {
    expect(paneClosable([header, pane('script'), pane('convo')], 2)).toBe(true);
  });

  test('the header may not, however it is pointed at', () => {
    expect(paneClosable([header, pane('script'), pane('convo')], 0)).toBe(false);
  });

  test('the last pane may not, which is the rule paneToClose states as NO_PANE', () => {
    const panes = [header, pane('script')];
    expect(paneClosable(panes, 1)).toBe(false);
    expect(paneToClose(panes)).toBe(NO_PANE);
  });

  test('a pane that is not there may not', () => {
    expect(paneClosable([header, pane('script'), pane('convo')], 7)).toBe(false);
  });
});
