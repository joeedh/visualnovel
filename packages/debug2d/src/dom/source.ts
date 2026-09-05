/**
 * `domSource()` — the FrameSource over a live document. Impure glue only: snapshot →
 * pure stacking walk → frame, plus the `elementsFromPoint` oracle (the browser's actual
 * hit order, captured so explainPick can cross-check the computed one) and the
 * css→device transform from devicePixelRatio. Untested in CI by design (research §13);
 * covered by the M5 live-validation script.
 */
import { invert, scaleMat, type Mat3 } from '../geom.js';
import { assembleFrame } from '../frame.js';
import { createSpaceRegistry } from '../spaces.js';
import type { CaptureOpts, Frame, FrameSource, SourceCaps, SpaceId } from '../types.js';
import { fragmentsFromSnapshot } from './stacking.js';
import { snapshotDom, type DocumentLike, type ElementLike } from './snapshot.js';

export const DOM_CAPS: SourceCaps = {
  exactZ          : false,
  paths           : false,
  perFragmentStyle: true,
  overdraw        : false,
  stacks          : false,
  continuous      : false,
  hitOracle       : true,
};

export type DomDocument = DocumentLike & {
  elementsFromPoint?(x: number, y: number): ArrayLike<ElementLike>;
};

export function domSource(doc: DomDocument): FrameSource {
  let frameIndex = 0;

  const dpr = () =>
    (doc.defaultView as { devicePixelRatio?: number } | null)?.devicePixelRatio ?? 1;

  function spaceTransform(from: SpaceId, to: SpaceId): Mat3 | null {
    if (from === 'css' && to === 'device') return scaleMat(dpr());
    if (from === 'device' && to === 'css') return invert(scaleMat(dpr()));
    return null;
  }

  return {
    id  : 'dom',
    caps: DOM_CAPS,
    spaceTransform,
    capture(opts?: CaptureOpts): Frame {
      const { root, idOf } = snapshotDom(doc);
      const fragments = root ? fragmentsFromSnapshot(root) : [];

      let oracle: Frame['oracle'];
      const at = opts?.oracleAt;
      if (at && doc.elementsFromPoint) {
        // Hits map back through the capture's element→id table; elements we did not
        // capture (overlay subtrees, skipped tags) drop out rather than faking ids.
        const ids = Array.from(doc.elementsFromPoint(at.x, at.y), (el) => idOf.get(el)).filter(
          (id): id is string => id !== undefined,
        );
        oracle = { point: at, ids };
      }

      return assembleFrame({
        index: frameIndex++,
        t    : Date.now(),
        fragments,
        spaces: createSpaceRegistry({
          css: { parent: 'device', label: 'devicePixelRatio', matrix: () => scaleMat(dpr()) },
        }),
        caps    : { dom: DOM_CAPS },
        fidelity: 'sampled',
        oracle,
      });
    },
  };
}
