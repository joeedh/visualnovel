/**
 * The branch editor: STUDIO's other main surface.
 *
 * Position is not semantic here — there is no `x`/`y` on a `Scene` and layout is automatic —
 * so every drag *means* something instead of moving something. Dragging from a card's handle
 * wires it to another scene; dragging a card onto a wire splices it into that edge; dragging a
 * wire's arrowhead off its target unwires it. Each commits one command on release.
 *
 * All three read their verdict from `intent.ts`, which asks the same `branchops` the command
 * will run, so the refusal shown mid-drag is the refusal that would have happened.
 *
 * The bar carries the two acts that change which scenes *exist*: a scene made from nothing (and
 * left unwired, because wiring it is a separate authorial fact) and the removal of the selected
 * one. Deleting asks `story.deleteScene`'s own `check` on hover, so what it would refuse — or how
 * many shots go with the scene — is on screen before the click.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { api } from '../../../api';
import { Canvas } from '../../../graph/Canvas';
import { handleAnchor, routeEdges, type EdgeRoute } from '../../../graph/edges.js';
import { edgeAt, nodeAt, type Pick as GraphPick } from '../../../graph/hit.js';
import { layoutGraph } from '../../../graph/layout.js';
import { fit, toWorld, IDENTITY, type Viewport } from '../../../graph/viewport.js';
import { SceneCard, StubCard } from './SceneCard';
import { branchGraph, CARD, type BranchGraph } from './graph.js';
import {
  asInvocation,
  deleteSceneIntent,
  newSceneIntent,
  proposeScene,
  selectionAfterDelete,
  type NewScene,
} from './compose.js';
import { grabAt } from './grab.js';
import {
  branchSplice,
  connect,
  relabel,
  scenesOf,
  splice,
  unwire,
} from '../../../../src/shared/interactions.js';
import { useAnimatedLayout, useBranch } from './useBranch.js';
import { noticeForCheck } from '../../../../src/shared/lineedit.js';
import type { Point, Size } from '../../../graph/types.js';
import type { StoryEdge } from '../../../../src/shared/ipc';
import type { SceneMap } from '../../../../src/shared/branchops';

/** Screen-pixel radius of the connect handle, and of the arrowhead you can pull off a target. */
const GRAB = 15;
/** How far the pointer must travel before a press on a card becomes a splice drag. */
const SLOP = 4;

/** Stable empties, so the memos above don't hand a new object to layout on every render. */
const EMPTY_SCENES: SceneMap = new Map();
const EMPTY_GRAPH: BranchGraph = { graph: { nodes: [], edges: [] }, stubs: new Set() };

type Drag =
  /** Pointer is down on a card but hasn't travelled yet — still a click. */
  | { kind: 'press'; scene: string; from: Point; at: Point }
  | { kind: 'connect'; scene: string; at: Point; over: string | null }
  | { kind: 'splice'; scene: string; at: Point; over: string | null }
  | { kind: 'unwire'; edge: string; at: Point; armed: boolean };

export function BranchEditor(props: {
  seed: (text: string) => void;
  /** The room's scene selection, shared with the `script` mode. */
  scene: string | null;
  onScene: (sceneId: string) => void;
}): JSX.Element {
  const { story, notice, setNotice, run } = useBranch();
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const [surface, setSurface] = useState<Size | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A scene asked for and not yet written. What is being edited is the command's own props.
  const [naming, setNaming] = useState<NewScene | null>(null);

  const scenes = useMemo(() => (story ? scenesOf(story) : EMPTY_SCENES), [story]);
  const { graph, stubs } = useMemo(() => (story ? branchGraph(story) : EMPTY_GRAPH), [story]);
  const target = useMemo(() => layoutGraph(graph), [graph]);
  const layout = useAnimatedLayout(target);
  const routes = useMemo(() => routeEdges(layout, graph.edges), [layout, graph.edges]);

  const sceneById = useMemo(() => new Map((story?.scenes ?? []).map((s) => [s.id, s])), [story]);
  const edgeById = useMemo(() => new Map((story?.edges ?? []).map((e) => [e.id, e])), [story]);

  // Fit once, when the first graph and the first surface size are both known. Re-fitting on
  // every reload would fight the relayout animation the whole point of which is continuity.
  const fitted = useRef(false);
  const refit = useCallback(
    (size: Size | null) => {
      if (!size || target.nodes.length === 0) return;
      setViewport(fit(target.bounds, size, { maxScale: 1 }));
    },
    [target],
  );
  useEffect(() => {
    if (fitted.current || !surface || target.nodes.length === 0) return;
    fitted.current = true;
    refit(surface);
  }, [refit, surface, target]);

  // Everything the window-level drag handlers need, refreshed each render — the listeners are
  // installed once per drag, so they cannot close over this render's values.
  const latest = useRef({ drag, layout, routes, viewport, scenes, edgeById, run, props });
  latest.current = { drag, layout, routes, viewport, scenes, edgeById, run, props };

  const element = useRef<HTMLElement | null>(null);
  const worldAt = (clientX: number, clientY: number): Point => {
    const box = element.current?.getBoundingClientRect();
    return toWorld(latest.current.viewport, {
      x: clientX - (box?.left ?? 0),
      y: clientY - (box?.top ?? 0),
    });
  };

  const onPick = useCallback(
    (hit: GraphPick, event: PointerEvent<HTMLDivElement>): void => {
      element.current = event.currentTarget;
      setEditing(null);
      const world = toWorld(viewport, {
        x: event.clientX - event.currentTarget.getBoundingClientRect().left,
        y: event.clientY - event.currentTarget.getBoundingClientRect().top,
      });
      const grab = GRAB / viewport.scale;

      // The two small targets are resolved from their own discs, before `pick`'s answer — see
      // `grab.ts` for why neither can be reached through it.
      const grabbed = grabAt(layout.nodes, routes, world, grab, stubs);
      if (grabbed?.kind === 'connect') {
        setDrag({ kind: 'connect', scene: grabbed.scene, at: world, over: null });
        return;
      }
      if (grabbed) {
        setSelected(grabbed.edge);
        setDrag({ kind: 'unwire', edge: grabbed.edge, at: world, armed: false });
        return;
      }

      if (hit.type === 'node') {
        if (stubs.has(hit.node.id)) return;
        setDrag({ kind: 'press', scene: hit.node.id, from: world, at: world });
        return;
      }
      if (hit.type === 'edge') {
        setSelected(hit.edge.id);
        return;
      }
      setSelected(null);
    },
    [layout, routes, stubs, viewport],
  );

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;

    const onMove = (event: globalThis.PointerEvent): void => {
      const state = latest.current;
      let current = state.drag;
      if (!current) return;
      const at = worldAt(event.clientX, event.clientY);

      // A press becomes a splice and is then tested in the same move: one big jump of a drag
      // has to land on the wire it ended over, not on whatever the *next* move finds.
      if (current.kind === 'press') {
        const travelled = Math.hypot(at.x - current.from.x, at.y - current.from.y);
        if (travelled * state.viewport.scale <= SLOP) {
          setDrag({ ...current, at });
          return;
        }
        current = { kind: 'splice', scene: current.scene, at, over: null };
      }
      if (current.kind === 'connect') {
        const over = nodeAt(state.layout, at);
        setDrag({ ...current, at, over: over && !stubs.has(over.id) ? over.id : null });
        return;
      }
      if (current.kind === 'splice') {
        const hit = edgeAt(state.routes, at, GRAB / state.viewport.scale);
        setDrag({ ...current, at, over: hit?.edge.id ?? null });
        return;
      }
      const end = state.routes.find((r) => r.id === current.edge)?.points.at(-1);
      const away = end ? Math.hypot(at.x - end.x, at.y - end.y) * state.viewport.scale : 0;
      setDrag({ ...current, at, armed: away > GRAB });
    };

    const onUp = (): void => {
      const state = latest.current;
      const current = state.drag;
      setDrag(null);
      if (!current) return;

      if (current.kind === 'press') {
        // A click is a selection *and* a scoped agent prompt: both are reads, and the selection
        // is what the `script` mode opens when the author switches to it.
        state.props.onScene(current.scene);
        state.props.seed(`Revise scene ${current.scene} — `);
        return;
      }
      if (current.kind === 'connect' && current.over) {
        const source = state.scenes.get(current.scene);
        const appended = source && (source.choices.length > 0 || source.next !== undefined);
        const decision = connect(state.scenes, current.scene, current.over);
        if (!decision.ok) return setNotice({ tone: 'refused', text: decision.reason });
        void state.run(decision.intent).then((ok) => {
          // A freshly appended choice is called "New choice" until it is named, so put the
          // cursor in it rather than leaving the author to find it.
          if (ok && appended) setEditing(`${current.scene}#choice:${source.choices.length}`);
        });
        return;
      }
      if (current.kind === 'splice' && current.over) {
        const edge = state.edgeById.get(current.over);
        if (!edge) return;
        const decision = splice(state.scenes, current.scene, edge);
        if (!decision.ok) return setNotice({ tone: 'refused', text: decision.reason });
        void state.run(decision.intent);
        return;
      }
      if (current.kind === 'unwire' && current.armed) {
        const edge = state.edgeById.get(current.edge);
        if (!edge) return;
        const decision = unwire(state.scenes, edge);
        if (!decision.ok) return setNotice({ tone: 'refused', text: decision.reason });
        void state.run(decision.intent);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // Deliberately only `dragging`: the handlers read everything else off `latest`, so this
    // installs once per drag rather than once per pointermove.
  }, [dragging, setNotice, stubs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setDrag(null);
      setEditing(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A splice verdict depends only on which card is being carried, so every wire can say
  // whether it would take it — the reason has to be visible during the gesture, not after.
  // This is `branch.splice`'s own `targets`, so the overlay and `interaction.targets` cannot
  // give an author and an agent different answers about the same drop.
  const verdicts = useMemo(() => {
    if (drag?.kind !== 'splice' || !story) return null;
    const judged = branchSplice.targets({ scenes, edges: story.edges }, drag.scene);
    return new Map(judged.map((v) => [v.target, v.accept ? null : v.reason] as const));
  }, [drag, scenes, story]);

  const hovering = drag?.kind === 'splice' && drag.over ? (verdicts?.get(drag.over) ?? null) : null;
  const line: { tone: string; text: string } | null = hovering
    ? { tone: 'refused', text: hovering }
    : drag?.kind === 'splice' && drag.over
      ? { tone: 'preview', text: `Splice ${drag.scene} into this edge.` }
      : drag?.kind === 'connect' && drag.over
        ? { tone: 'preview', text: `Wire ${drag.scene} → ${drag.over}.` }
        : drag?.kind === 'unwire' && drag.armed
          ? { tone: 'preview', text: 'Release to unwire.' }
          : notice;

  const dead = story?.scenes.filter((s) => !s.reachable).length ?? 0;
  const carrying = drag?.kind === 'splice' ? drag : null;
  const wiring = drag?.kind === 'connect' ? drag : null;

  const renderNode = (node: { id: string }): JSX.Element => {
    const scene = sceneById.get(node.id);
    if (!scene) return <StubCard id={node.id} />;
    return (
      <SceneCard
        scene={scene}
        entry={story?.start === scene.id}
        selected={
          props.scene === scene.id || wiring?.scene === scene.id || wiring?.over === scene.id
        }
      />
    );
  };

  const commitLabel = (edge: StoryEdge, label: string): void => {
    setEditing(null);
    const trimmed = label.trim();
    if (!trimmed || trimmed === edge.label) return;
    const decision = relabel(scenes, edge, trimmed);
    if (!decision.ok) return setNotice({ tone: 'refused', text: decision.reason });
    void run(decision.intent);
  };

  const renderLabel = (route: EdgeRoute): JSX.Element | null => {
    const edge = edgeById.get(route.id);
    if (!edge) return null;
    if (editing === edge.id) {
      return (
        <input
          className="edge-input"
          defaultValue={edge.label ?? ''}
          autoFocus
          onBlur={(e) => commitLabel(edge, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLabel(edge, e.currentTarget.value);
            if (e.key === 'Escape') setEditing(null);
          }}
        />
      );
    }
    if (!edge.label) return null;
    return (
      <button
        className={`edge-label${edge.id === selected ? ' sel' : ''}`}
        onClick={() => setEditing(edge.id)}
        title="Rename this choice"
      >
        {edge.label}
      </button>
    );
  };

  /** What removing the selected scene would cost, from `deleteScene`'s own `check`. */
  const askDelete = (scene: string): void => {
    void api
      .invoke('command:check', asInvocation(deleteSceneIntent(scene)))
      .then((check) => setNotice(noticeForCheck(check)));
  };

  /**
   * Remove the selected scene and move the selection off it — the room shares that selection with
   * the script column, which would otherwise open a scene that no longer exists. `story` is still
   * the pre-delete graph here, which is exactly what says what is left.
   */
  const remove = async (scene: string): Promise<void> => {
    if (!(await run(deleteSceneIntent(scene)))) return;
    const next = selectionAfterDelete(story, scene);
    if (next) props.onScene(next);
  };

  /** Write the named scene, then select it — a scene is made in order to be written in. */
  const write = async (): Promise<void> => {
    if (!naming) return;
    const asked = naming;
    setNaming(null);
    if (await run(newSceneIntent(asked))) props.onScene(asked.scene);
  };

  /**
   * The strip that names a scene before it exists. In the bar rather than on the canvas: there is
   * no position for a card that has no scene behind it yet, and position isn't semantic here.
   */
  const namer = (): JSX.Element => {
    const keys = (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') void write();
      if (e.key === 'Escape') setNaming(null);
    };
    return (
      <div className="branch-name">
        <input
          className="np"
          aria-label="The new scene's id"
          autoFocus
          value={naming?.scene ?? ''}
          onChange={(e) => setNaming({ ...(naming as NewScene), scene: e.target.value })}
          onKeyDown={keys}
        />
        <input
          className="np wide"
          aria-label="The new scene's heading"
          value={naming?.heading ?? ''}
          onChange={(e) => setNaming({ ...(naming as NewScene), heading: e.target.value })}
          onKeyDown={keys}
        />
        <button className="go" onClick={() => void write()}>
          Write it
        </button>
        <button className="no" onClick={() => setNaming(null)}>
          Cancel
        </button>
      </div>
    );
  };

  if (story && story.scenes.length === 0) {
    return (
      <div className="branch empty">
        <p className="invite">
          No scenes yet. Ask vnauthor for the opening scene below, or make an empty one here and
          write it in the script column — either way it appears as a card you can wire the rest of
          the story to.
        </p>
        {naming ? (
          namer()
        ) : (
          <button className="ghost wide" onClick={() => setNaming(proposeScene(story))}>
            + scene
          </button>
        )}
        {notice && <div className={`branch-line ${notice.tone}`}>{notice.text}</div>}
      </div>
    );
  }

  const carried = carrying ? sceneById.get(carrying.scene) : undefined;

  return (
    <div className="branch">
      <div className="branch-bar">
        <span className="tt">BRANCHES</span>
        <span className="ct">
          {story?.scenes.length ?? 0} scenes · {story?.edges.length ?? 0} edges
          {dead > 0 ? ` · ${dead} unreachable` : ''}
        </span>
        {naming ? (
          namer()
        ) : (
          <>
            <button className="ghost" onClick={() => setNaming(proposeScene(story))}>
              + scene
            </button>
            {props.scene && (
              // Hover asks the command; the click runs it. So a scene something still points at
              // says so before the pointer goes down, in the command's own words.
              <button
                className="ghost danger"
                onPointerEnter={() => askDelete(props.scene as string)}
                onFocus={() => askDelete(props.scene as string)}
                onClick={() => void remove(props.scene as string)}
              >
                delete {props.scene}
              </button>
            )}
          </>
        )}
        <button className="ghost" onClick={() => refit(surface)} title="Fit to view">
          ⤢
        </button>
      </div>

      <Canvas
        className="branch-canvas"
        layout={layout}
        edges={routes}
        viewport={viewport}
        onViewportChange={setViewport}
        onSurface={setSurface}
        onPick={onPick}
        renderNode={renderNode}
        renderLabel={renderLabel}
        pickOptions={{ edgeSlop: 10 }}
        overlay={
          <>
            <svg className="branch-overlay" aria-hidden="true">
              {verdicts
                ? routes.map((route) => (
                    <path
                      key={`v-${route.id}`}
                      d={route.path}
                      className={`verdict ${verdicts.get(route.id) ? 'refuse' : 'accept'}${
                        carrying?.over === route.id ? ' over' : ''
                      }`}
                    />
                  ))
                : null}
              {wiring ? (
                <line
                  className="ghost-wire"
                  x1={handleAnchor(layout.byId.get(wiring.scene) ?? ZERO).x}
                  y1={handleAnchor(layout.byId.get(wiring.scene) ?? ZERO).y}
                  x2={wiring.at.x}
                  y2={wiring.at.y}
                />
              ) : null}
              {selected && drag === null
                ? (() => {
                    const end = routes.find((r) => r.id === selected)?.points.at(-1);
                    return end ? <circle className="endpoint" cx={end.x} cy={end.y} r={5} /> : null;
                  })()
                : null}
            </svg>
            {carried && carrying ? (
              <div
                className="carried-card"
                style={{
                  left: carrying.at.x - CARD.width / 2,
                  top: carrying.at.y - CARD.height / 2,
                  width: CARD.width,
                  height: CARD.height,
                }}
              >
                <SceneCard scene={carried} entry={false} selected={false} ghost />
              </div>
            ) : null}
          </>
        }
      />

      <div className={`branch-line ${line?.tone ?? 'idle'}`}>
        {line?.text ??
          'Drag a card’s ⌄ handle onto another scene to wire it; drop a card on a wire to splice it in.'}
      </div>
    </div>
  );
}

/** Anchor fallback for the one frame where a dragged node has left the layout mid-reload. */
const ZERO = { id: '', width: 0, height: 0, x: 0, y: 0, rank: 0, order: 0 };
