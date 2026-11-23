import { PhaseTimer } from '@vn/commands';
import { sceneFromDoc } from '@vn/model';
import { ProjectPaths, parseShots, readSceneChunk, writeShotBubbles } from '@vn/store';
import { hasConflictMarkers, readText, sha256 } from '@vn/util';
import { setBubbles as planBubbles, type ShotOutfitOp } from '@vn/scriptedit';
import type { PanelBubble } from '@vn/types';
import type { BubbleSave } from '../../../shared/ipc.js';
import type { WorkspaceSession } from '../core.js';

/** What `story.setBubbles` would do, without writing it. */
export async function previewBubbles(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  bubbles: readonly PanelBubble[],
): Promise<ShotOutfitOp> {
  return (await bubblesRule(session, sceneId, shotId, bubbles)).op;
}

async function bubblesRule(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  bubbles: readonly PanelBubble[],
  timing = new PhaseTimer(),
) {
  // Full project discovery previously restricted scenes to filenames in scenes/.
  if (!sceneId || /[\\/:\0]/.test(sceneId) || sceneId === '.' || sceneId === '..') {
    throw new Error('A scene id must name one scene file.');
  }
  const paths = new ProjectPaths(session.dir);
  const chunk = await timing.measure('sceneReadMs', () => readSceneChunk(paths, sceneId));
  if (!chunk) throw new Error(`No scene "${sceneId}".`);
  if (hasConflictMarkers(chunk.text))
    throw new Error('Resolve the scene conflict before saving bubbles.');
  const parsed = sceneFromDoc(chunk.doc, sceneId);
  if (!parsed.ok) throw new Error(parsed.diagnostic.message);
  if (parsed.value.diagnostics.some((d) => d.severity === 'error')) {
    throw new Error(
      parsed.value.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => d.message)
        .join('\n'),
    );
  }
  const before = await timing.measure('shotsReadMs', async () => {
    try {
      return await readText(paths.shotsFile(sceneId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Scene "${sceneId}" has no decomposition yet — run the pipeline past the gate.`,
        );
      }
      throw err;
    }
  });
  const loaded = parseShots(
    before,
    sceneId,
    paths.shotsFile(sceneId),
    new Set(parsed.value.scene.lines.map((l) => l.id)),
  );
  const op = timing.measureSync('bubbleValidationMs', () =>
    planBubbles(loaded.shots, { shot: shotId, bubbles }),
  );
  return { paths, chunk, before, op };
}

/**
 * Restate where the runner draws one page's bubbles. No prompt reads a bubble, so nothing
 * re-hashes and nothing is drawn again; the page's lines without one keep the dialogue box.
 */
export async function setBubbles(
  session: WorkspaceSession,
  sceneId: string,
  shotId: string,
  bubbles: readonly PanelBubble[],
  timing = new PhaseTimer(),
  assertUndoInput?: (path: string, text: string) => void,
): Promise<{ ok: boolean; message: string; written: string[]; saved?: BubbleSave }> {
  const { paths, chunk, before, op } = await bubblesRule(session, sceneId, shotId, bubbles, timing);
  if (!op.ok) return { ok: false, message: op.error, written: [] };
  const written = `vngen/work/shots/${sceneId}.json`;
  assertUndoInput?.(written, before);
  const panels = op.shots.find((s) => s.id === shotId)!.panels!;
  const next = await timing.measure('shotsWriteMs', () =>
    writeShotBubbles(paths, sceneId, shotId, panels, before, async () => {
      if ((await readText(chunk.file)) !== chunk.text) {
        throw new Error('The scene changed while saving bubbles. Reload the page and try again.');
      }
    }),
  );
  return {
    ok     : true,
    message: op.message,
    written: [written],
    saved: {
      kind: 'bubbles',
      sceneId,
      shotId,
      panels,
      revision: { scene: sha256(chunk.text), shots: sha256(next) },
    },
  };
}
