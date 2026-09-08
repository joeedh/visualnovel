import { controls, diagnosticScene, rowAction, rowText } from '../diagnostics.js';
import { duplicateKeys, keyOf } from '../anchors.js';
import type { Diagnostic } from '@vn/types';

const diag = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  severity: 'error',
  code    : 'dangling_line_id',
  message : 'names no line',
  ...over,
});

describe('diagnosticScene', () => {
  it('answers the scene a diagnostic points at', () => {
    expect(diagnosticScene(diag({ where: 'arrival' }), ['arrival', 'ending'])).toBe('arrival');
  });

  it('declines one with nowhere to go', () => {
    expect(diagnosticScene(diag(), ['arrival'])).toBeNull();
  });

  it('declines an entity that is not a scene — `where` is any entity id', () => {
    expect(diagnosticScene(diag({ code: 'bad_character', where: 'aiko' }), ['arrival'])).toBeNull();
  });

  it('declines a scene that does not exist, which is what the diagnostic is often about', () => {
    const missing = diag({ code: 'missing_start', where: 'prologue' });
    expect(diagnosticScene(missing, ['arrival', 'ending'])).toBeNull();
    expect(diagnosticScene(missing, [])).toBeNull();
  });
});

describe('rowText', () => {
  it('marks the severity and names what the diagnostic is about', () => {
    expect(rowText(diag({ where: 'arrival' }))).toBe('● names no line (arrival)');
    expect(rowText(diag({ severity: 'warning' }))).toBe('○ names no line');
  });
});

describe('rowAction', () => {
  const line = diag({ where: 'arrival' });

  it('selects the scene, opens it where the route says, then closes the popup', () => {
    expect(rowAction(line, 'arrival', ['documents'])).toEqual({
      ok     : true,
      id     : 'ui.publish',
      props  : { sceneId: 'arrival', shotId: '' },
      on     : 'scene/arrival',
      label  : '● names no line (arrival)',
      tooltip: expect.stringMatching(/click to open arrival$/),
      then: [
        { id: 'view.open', props: { editor: 'script', where: 'elsewhere', subject: '' } },
        { id: 'popup.close', props: { popup: 'diagnostics' } },
      ],
    });
  });

  it('opens Script here when it is already up', () => {
    expect(rowAction(line, 'arrival', ['documents', 'script'])).toMatchObject({
      then: [{ id: 'view.open', props: { where: 'here' } }, { id: 'popup.close' }],
    });
  });

  it('keys the row by the scene, which is what a select step names', () => {
    expect(keyOf(rowAction(line, 'arrival', []))).toBe('item:scene/arrival');
  });
});

describe('controls', () => {
  it('lists a row for each diagnostic about a listed scene and nothing for the rest', () => {
    const diagnostics = [
      diag({ where: 'arrival' }),
      diag({ code: 'bad_character', where: 'aiko' }),
      diag({ code: 'missing_start', where: 'prologue' }),
      diag({ where: 'ending' }),
    ];
    const listed = controls({ diagnostics, scenes: ['arrival', 'ending'], visible: ['documents'] });
    expect(listed.map(keyOf)).toEqual(['item:scene/arrival', 'item:scene/ending']);
    expect(duplicateKeys(listed)).toEqual([]);
  });
});
