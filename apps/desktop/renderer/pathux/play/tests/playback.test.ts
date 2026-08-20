import type { Playable } from '../../../../src/shared/ipc.js';
import {
  advance,
  assetUrl,
  back,
  choose,
  framesOf,
  parseSave,
  saveKeyOf,
  startOf,
} from '../playback.js';

function play(): Playable {
  return {
    version: 1,
    title: 'Demo',
    start: 'a',
    portraitOverlay: false,
    characters: { aiko: { name: 'Aiko' } },
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
        next: 'b',
      },
      b: {
        beats: [{ type: 'say', who: 'aiko', text: 'Again.' }],
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
