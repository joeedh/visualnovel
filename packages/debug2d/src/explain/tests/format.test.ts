import { makeTestFrame, staticSource } from '../../frame.js';
import { createDebugger } from '../../query/engine.js';
import { fmtNum, fmtRect, padCols } from '../format.js';

describe('format', () => {
  it('canonicalizes floats to at most one decimal', () => {
    expect(fmtNum(2)).toBe('2');
    expect(fmtNum(2.04)).toBe('2');
    expect(fmtNum(2.05)).toBe('2.1');
    expect(fmtNum(-0.01)).toBe('0');
    expect(fmtNum(179.9999)).toBe('180');
  });

  it('formats rects as x,y wxh', () => {
    expect(fmtRect({ x: 404, y: 72, w: 180.333, h: 40 })).toBe('404,72 180.3x40');
  });

  it('pads columns without trailing whitespace', () => {
    expect(
      padCols([
        ['a', 'bb', ''],
        ['ccc', 'd', 'e'],
      ]),
    ).toEqual(['a    bb', 'ccc  d   e']);
  });
});

describe('ResultSet explain/table goldens', () => {
  const dbg = () =>
    createDebugger({
      sources: [
        staticSource(
          makeTestFrame([
            { id: 'bg', bounds: { x: 0, y: 0, w: 800, h: 600 } },
            {
              id    : 'card',
              bounds: { x: 100, y: 100, w: 200, h: 150 },
              owner : { id: 'Floor/card', label: 'Floor/card', kind: 'component' },
            },
            {
              id    : 'label',
              bounds: { x: 110, y: 110, w: 80, h: 20 },
              owner: {
                id    : 'Floor/label',
                label : 'Floor/label',
                kind  : 'component',
                parent: 'Floor/card',
              },
            },
            { id: 'ghost', bounds: { x: 150, y: 120, w: 40, h: 40 }, style: { alpha: 0 } },
          ]),
        ),
      ],
    });

  it('explain() is the compact ASCII stack, golden-stable', () => {
    expect(dbg().at(150, 125).explain()).toBe(
      [
        'at(150, 125) css → 4 fragments, top-first',
        '  test  #ghost  box  ghost        150,120 40x40    z=3  α0',
        '  test  #label  box  Floor/label  110,110 80x20    z=2',
        '  test  #card   box  Floor/card   100,100 200x150  z=1',
        '  test  #bg     box  bg           0,0 800x600      z=0',
      ].join('\n'),
    );
  });

  it('table() is plain JSON-safe data', () => {
    expect(dbg().at(150, 125).table()).toEqual([
      {
        id    : 'ghost',
        owner : 'ghost',
        source: 'test',
        kind  : 'box',
        bounds: '150,120 40x40',
        tags  : [],
        z     : 3,
      },
      {
        id    : 'label',
        owner : 'Floor/label',
        source: 'test',
        kind  : 'box',
        bounds: '110,110 80x20',
        tags  : [],
        z     : 2,
      },
      {
        id    : 'card',
        owner : 'Floor/card',
        source: 'test',
        kind  : 'box',
        bounds: '100,100 200x150',
        tags  : [],
        z     : 1,
      },
      { id: 'bg', owner: 'bg', source: 'test', kind: 'box', bounds: '0,0 800x600', tags: [], z: 0 },
    ]);
  });
});
