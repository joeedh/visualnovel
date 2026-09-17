import type { Playable } from '../../../../src/shared/ipc.js';
import {
  advance,
  assetUrl,
  back,
  choose,
  dimPath,
  framesOf,
  jumpTo,
  parseSave,
  samePos,
  saveKeyOf,
  startOf,
} from '../playback.js';

function play(): Playable {
  return {
    version        : 1,
    title          : 'Demo',
    start          : 'a',
    portraitOverlay: false,
    characters     : { aiko: { name: 'Aiko' } },
    scenes: {
      a: {
        beats: [
          { type: 'show', shot: 'a.s1', image: { hash: 'h1', ext: 'png' } },
          { type: 'narrate', text: 'Rain.' },
          { type: 'say', who: 'aiko', text: 'Hello.' },
          { type: 'show', shot: 'a.s2' },
          { type: 'narrate', text: 'Silence.' },
        ],
        choices: [],
        next   : 'b',
      },
      b: {
        beats  : [{ type: 'say', who: 'aiko', text: 'Again.' }],
        choices: [
          { label: 'left', goto: 'a' },
          { label: 'right', goto: 'c' },
        ],
      },
    },
  };
}

describe('framesOf', () => {
  it('folds a show into the frames that follow it, carrying bg and shot', () => {
    const frames = framesOf(play().scenes['a']);

    expect(frames.map((f) => f.text)).toEqual(['Rain.', 'Hello.', 'Silence.']);
    expect(frames[0]?.shotId).toBe('a.s1');
    expect(frames[1]?.shotId).toBe('a.s1');
    expect(frames[2]?.shotId).toBe('a.s2');
    // The second show has no image, so the frame it opens has no background
    expect(frames[2]?.bg).toBeUndefined();
  });

  it('carries the last speaker through narration, but names one only for dialogue', () => {
    const frames = framesOf(play().scenes['a']);

    expect(frames[0]?.portraitWho).toBeUndefined();
    expect(frames[1]?.speaker).toBe('aiko');
    expect(frames[2]?.speaker).toBeUndefined();
    expect(frames[2]?.portraitWho).toBe('aiko');
  });

  it('a missing scene has no frames', () => {
    expect(framesOf(undefined)).toEqual([]);
  });

  it('lights the panel that letters a line, and none for a line no panel letters', () => {
    const top: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 0.5],
      [0, 0.5],
    ];
    const bottom: [number, number][] = [
      [0, 0.5],
      [1, 0.5],
      [1, 1],
      [0, 1],
    ];
    const frames = framesOf({
      beats: [
        {
          type  : 'show',
          shot  : 'a.page',
          panels: [
            { shape: top, lines: ['a:L1'] },
            { shape: bottom, lines: ['a:L2', 'a:L3'] },
          ],
        },
        { type: 'narrate', text: 'Rain.', line: 'a:L1' },
        { type: 'say', who: 'aiko', text: 'Hello.', line: 'a:L2' },
        { type: 'narrate', text: 'Unlettered.', line: 'a:L9' },
        { type: 'narrate', text: 'No id.' },
        // The next frame's panels do not carry over
        { type: 'show', shot: 'a.s2' },
        { type: 'narrate', text: 'Silence.', line: 'a:L1' },
      ],
      choices: [],
    });

    expect(frames.map((f) => f.panel)).toEqual([top, bottom, undefined, undefined, undefined]);
    expect('panel' in frames[2]!).toBe(false);
    // `page` is set on all four frames the page is on screen for, whether a panel is lit or
    // not, and absent once the next shot's frame arrives
    expect(frames.map((f) => f.page)).toEqual([true, true, true, true, undefined]);
  });

  it('carries a line’s bubble onto its frame, and none onto a line without one', () => {
    const shape: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const frames = framesOf({
      beats: [
        {
          type  : 'show',
          shot  : 'a.page',
          panels: [
            {
              shape,
              lines  : ['a:L1', 'a:L2'],
              bubbles: [{ line: 'a:L1', anchor: [0.3, 0.2], tail: [0.4, 0.5] }],
            },
          ],
        },
        { type: 'say', who: 'aiko', text: 'Hello.', line: 'a:L1' },
        { type: 'say', who: 'aiko', text: 'Still here.', line: 'a:L2' },
      ],
      choices: [],
    });
    expect(frames[0]).toMatchObject({
      panel : shape,
      bubble: { anchor: [0.3, 0.2], tail: [0.4, 0.5] },
    });
    expect('bubble' in frames[1]!).toBe(false);
  });
});

describe('dimPath', () => {
  it('is the unit square and the panel as two subpaths', () => {
    expect(
      dimPath([
        [0, 0.5],
        [1, 0.5],
        [1, 1],
        [0, 1],
      ]),
    ).toBe('M0 0H1V1H0ZM0 0.5L1 0.5L1 1L0 1Z');
  });
});

describe('navigation', () => {
  it('advances one frame at a time, then past the end onto the linear next', () => {
    const p = play();
    let history = startOf(p);
    expect(history).toEqual([{ sceneId: 'a', frameIndex: 0 }]);

    for (let i = 0; i < 3; i++) history = advance(p, history);
    expect(history[history.length - 1]).toEqual({ sceneId: 'a', frameIndex: 3 });

    history = advance(p, history);
    expect(history[history.length - 1]).toEqual({ sceneId: 'b', frameIndex: 0 });
  });

  it('stops rather than guessing when the scene ends on choices', () => {
    const p = play();
    const at = [{ sceneId: 'b', frameIndex: 1 }];

    expect(advance(p, at)).toBe(at);
    expect(choose(at, 'c')).toEqual([...at, { sceneId: 'c', frameIndex: 0 }]);
  });

  it('a scene the graph points at but does not have goes nowhere', () => {
    expect(advance(play(), [{ sceneId: 'gone', frameIndex: 0 }])).toHaveLength(1);
  });

  it('back never pops the entry position', () => {
    const one = [{ sceneId: 'a', frameIndex: 0 }];
    expect(back(one)).toBe(one);
    expect(back([...one, { sceneId: 'a', frameIndex: 1 }])).toEqual(one);
  });

  it('a playable with no entry scene starts nowhere', () => {
    const p = play();
    delete p.start;
    expect(startOf(p)).toEqual([]);
  });
});

describe('following a selection made elsewhere', () => {
  it('lands on the first frame the named shot drew', () => {
    expect(jumpTo(play(), 'a', 'a.s2')).toEqual({ sceneId: 'a', frameIndex: 2 });
  });

  it('lands on the scene’s first frame when no shot is named', () => {
    expect(jumpTo(play(), 'a', '')).toEqual({ sceneId: 'a', frameIndex: 0 });
  });

  // A shot covering only stage directions has no frame of its own, and a shot id left over from
  // another scene is a stale selection rather than a reason to refuse the scene.
  it('falls back to the first frame for a shot the scene’s frames do not name', () => {
    expect(jumpTo(play(), 'a', 'b.s1')).toEqual({ sceneId: 'a', frameIndex: 0 });
  });

  it('has nowhere to go in a scene the playable does not have', () => {
    expect(jumpTo(play(), 'gone', '')).toBeNull();
  });

  it('knows a jump that would not move', () => {
    const at = { sceneId: 'a', frameIndex: 2 };
    expect(samePos(at, { ...at })).toBe(true);
    expect(samePos(at, { sceneId: 'a', frameIndex: 3 })).toBe(false);
    expect(samePos(undefined, at)).toBe(false);
    expect(samePos(at, null)).toBe(false);
  });
});

describe('saves', () => {
  it('are keyed per title', () => {
    expect(saveKeyOf(play())).toBe('vn.runner.save.Demo');
    expect(saveKeyOf(undefined)).toBe('vn.runner.save');
  });

  it('accept a history stack and refuse anything else', () => {
    const history = [{ sceneId: 'a', frameIndex: 2 }];

    expect(parseSave(JSON.stringify(history))).toEqual(history);
    expect(parseSave(null)).toBeUndefined();
    expect(parseSave('[]')).toBeUndefined();
    expect(parseSave('{"sceneId":"a"}')).toBeUndefined();
    expect(parseSave('not json')).toBeUndefined();
    expect(parseSave('[{"sceneId":"a","frameIndex":"2"}]')).toBeUndefined();
  });
});

it('an asset ref becomes a vnasset url, and nothing becomes nothing', () => {
  expect(assetUrl({ hash: 'h', ext: 'png' })).toBe('vnasset://h.png');
  expect(assetUrl(undefined)).toBeUndefined();
});
