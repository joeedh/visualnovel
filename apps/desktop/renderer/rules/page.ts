/**
 * What the Page editor offers: the layout row, the Generate button and the shot's model, the
 * panels on the page and the corners of the selected one, the line rows, the shot's cast, and
 * the selected panel's fields. A panel edit is `story.setPanels` with the whole list the control
 * would produce, judged here by the same `setPanels` rule main runs, so a refused control says
 * the rule's own sentence before anything is sent.
 */
import { evenLayout, LAYOUT_TEMPLATES, type PanelShape } from '@vn/artgen/layout';
import { letterLine, setPanels } from '@vn/scriptedit';
import type { PagePanel, PanelBox } from '@vn/types';
import type { CoverageLine, CoverageShot } from '../../src/shared/ipc.js';
import { refuse, type Offer } from './anchors.js';
import { startDrag, view } from './effects.js';
import { addCastAction, removeCastAction, type ShotCast } from './timeline/cast.js';

/** What the Page editor reads when it draws. */
export interface PageState {
  sceneId: string;
  /** The scene's shots, the page among them; empty while the scene has no storyboard. */
  shots: readonly CoverageShot[];
  /** The shot on screen, which may be a page or a frame, or `''` with nothing selected. */
  shotId: string;
  /** The scene's lines in screenplay order; the page's covered lines are read out of them. */
  lines: readonly CoverageLine[];
  /** The index of the selected panel, or `null`. */
  selected: number | null;
  /** Every character the project describes, which is who the shot could be given. */
  characters?: readonly string[];
  /** The project's `models.image`, which the shot's model picker inherits when it says nothing. */
  imageModel?: string;
}

/** One entry of the layout row: a name and the outlines it lays the page out in. */
export interface Layout {
  name: string;
  shapes: readonly PanelShape[];
  /** The layout in the author's words, for the glyph's tooltip. */
  words: string;
}

const NAMED_WORDS: Readonly<Record<string, string>> = {
  'two-tier'       : 'two tiers of two',
  'three-tier'     : 'three tiers of two',
  'diagonal-split' : 'two panels split on a diagonal',
  'splash-over-two': 'a splash over a row of two',
};

const EVEN_COUNTS = [2, 3, 4, 5, 6] as const;

/**
 * The layout row: every named template in `LAYOUT_TEMPLATES`, then the even layout at each count
 * from two to six. Derived from the module, so a template added there is drawn here unasked.
 */
export const LAYOUTS: readonly Layout[] = [
  ...Object.entries(LAYOUT_TEMPLATES).map(([name, shapes]) => ({
    name,
    shapes,
    words: NAMED_WORDS[name] ?? name,
  })),
  ...EVEN_COUNTS.map((n) => ({
    name  : `even-${n}`,
    shapes: evenLayout(n),
    words : `${n} panels in tiers of two`,
  })),
];

/** A fresh panel for a slot a layout added: medium, nobody in it, lettering nothing. */
export const blankPanel = (shape: PanelShape): PagePanel => ({
  shape      : shape.map((p) => [...p] as [number, number]),
  framing    : 'medium',
  subjects   : [],
  coversLines: [],
});

const EPSILON = 1e-6;

/** Whether two outlines are the same corners in the same order. */
export function sameShape(
  a: readonly PanelShape[number][],
  b: readonly PanelShape[number][],
): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < EPSILON && Math.abs(p[1] - b[i]![1]) < EPSILON)
  );
}

/** Whether a page's panels sit exactly in a layout's outlines, which is when its glyph is filled. */
export function inLayout(panels: readonly PagePanel[], layout: Layout): boolean {
  return (
    panels.length === layout.shapes.length &&
    panels.every((p, i) => sameShape(p.shape, layout.shapes[i]!))
  );
}

/**
 * The page laid out again in `shapes`. A panel keeps everything but its outline; a slot the
 * layout adds starts blank; a panel the layout drops hands its lines to the last panel kept.
 */
export function relaid(panels: readonly PagePanel[], shapes: readonly PanelShape[]): PagePanel[] {
  const kept = shapes.map((shape, i) => {
    const panel = panels[i];
    return panel
      ? { ...panel, shape: shape.map((p) => [...p] as [number, number]) }
      : blankPanel(shape);
  });
  const dropped = panels.slice(shapes.length).flatMap((p) => p.coversLines);
  const last = kept[kept.length - 1];
  if (last && dropped.length > 0) last.coversLines = [...last.coversLines, ...dropped];
  return kept;
}

/** The shot the editor is on, or `undefined` when the scene has no such shot. */
export const shotOf = (state: PageState): CoverageShot | undefined =>
  state.shots.find((s) => s.id === state.shotId);

/** The page's covered lines, in screenplay order. */
export function pageLines(state: PageState): CoverageLine[] {
  const shot = shotOf(state);
  if (!shot) return [];
  const covered = new Set(shot.coversLines);
  return state.lines.filter((l) => covered.has(l.id));
}

/** Which panel letters a line, as an index, or `null` when none does. */
export function panelOfLine(panels: readonly PagePanel[], lineId: string): number | null {
  const at = panels.findIndex((p) => p.coversLines.includes(lineId));
  return at < 0 ? null : at;
}

/** The selected panel, or `undefined` when none is or the shot is a frame. */
export function selectedPanel(state: PageState): PagePanel | undefined {
  const shot = shotOf(state);
  return state.selected === null ? undefined : shot?.panels?.[state.selected];
}

/** One corner moved, clamped to the page. */
export function withCorner(
  panels: readonly PagePanel[],
  panel: number,
  corner: number,
  to: readonly [number, number],
): PagePanel[] {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const point: [number, number] = [clamp(to[0]), clamp(to[1])];
  return panels.map((p, i) =>
    i === panel ? { ...p, shape: p.shape.map((q, j) => (j === corner ? point : q)) } : p,
  );
}

/** A corner added on the edge after `corner`, at that edge's midpoint. */
export function withCornerAfter(
  panels: readonly PagePanel[],
  panel: number,
  corner: number,
): PagePanel[] {
  return panels.map((p, i) => {
    if (i !== panel) return p;
    const a = p.shape[corner]!;
    const b = p.shape[(corner + 1) % p.shape.length]!;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return { ...p, shape: [...p.shape.slice(0, corner + 1), mid, ...p.shape.slice(corner + 1)] };
  });
}

/** One corner removed; the caller has checked three remain. */
export function withoutCorner(
  panels: readonly PagePanel[],
  panel: number,
  corner: number,
): PagePanel[] {
  return panels.map((p, i) =>
    i === panel ? { ...p, shape: p.shape.filter((_, j) => j !== corner) } : p,
  );
}

/** One panel's record rewritten. */
export function withPanel(
  panels: readonly PagePanel[],
  index: number,
  change: Partial<PagePanel>,
): PagePanel[] {
  return panels.map((p, i) => (i === index ? { ...p, ...change } : p));
}

/** The panel with `characterId` put in or taken out of its cast. */
export function withCast(
  panels: readonly PagePanel[],
  index: number,
  characterId: string,
  present: boolean,
): PagePanel[] {
  const panel = panels[index];
  if (!panel) return [...panels];
  const without = panel.subjects.filter((s) => s.characterId !== characterId);
  const subjects = present ? [...without, { characterId }] : without;
  return withPanel(panels, index, { subjects });
}

/** The invocation `story.setPanels` takes for a list. */
export const panelsProps = (
  state: PageState,
  panels: readonly PagePanel[],
): { scene: string; shot: string; panels: string } => ({
  scene : state.sceneId,
  shot  : state.shotId,
  panels: JSON.stringify(panels),
});

/**
 * A `story.setPanels` offer carrying `panels`, judged by the rule: enabled with the rule's own
 * sentence after the control's, or refused with its reason. `on` tells the control apart.
 */
export function panelsOffer(
  state: PageState,
  control: { on: string; label: string; tooltip: string },
  panels: readonly PagePanel[],
): Offer {
  const base = { id: 'story.setPanels', ...control };
  const op = setPanels(state.shots, {
    shot: state.shotId,
    panels,
    lineOrder: state.lines.map((l) => l.id),
  });
  if (!op.ok) return { ...refuse(op.error), ...base };
  return {
    ok   : true,
    props: panelsProps(state, panels),
    ...base,
    tooltip: `${control.tooltip} ${op.message}`,
  };
}

/** One glyph of the layout row, which lays the page out in that layout at its panel count. */
export function layoutAction(state: PageState, layout: Layout): Offer {
  const shot = shotOf(state);
  const current = shot?.panels ?? [];
  const on = `layout/${layout.name}`;
  const label = layout.words;
  if (!shot) {
    return { ...refuse('No shot is on screen.'), id: 'story.setPanels', on, label, tooltip: '' };
  }
  const opening =
    current.length === 0 ? 'Make this frame a page laid out as' : 'Lay this page out as';
  return panelsOffer(
    state,
    { on, label, tooltip: `${opening} ${layout.words}.` },
    relaid(current, layout.shapes),
  );
}

/** A panel's hit area on the page: a click selects it, and its corners appear. */
export function panelAction(index: number): Offer {
  const n = index + 1;
  return {
    ok: true,
    ...view('scope'),
    on     : `panel/${n}`,
    label  : `Panel ${n}`,
    tooltip:
      `Select panel ${n} to move its corners and edit its framing, camera and cast. ` +
      'Double-click an edge to add a corner there.',
  };
}

/** One corner of the selected panel: dragged to move it, with the list read off the page on release. */
export function cornerAction(state: PageState, panel: number, corner: number): Offer {
  const shot = shotOf(state);
  const on = `corner/${panel + 1}/${corner + 1}`;
  const label = '';
  const tooltip =
    `Drag to move this corner of panel ${panel + 1}; arrows nudge it by half a percent of the ` +
    'page and Shift-arrows by two, Delete removes it. The page is drawn again on the next run.';
  if (!shot)
    return { ...refuse('No shot is on screen.'), id: 'story.setPanels', on, label, tooltip };
  return {
    ok   : true,
    id   : 'story.setPanels',
    props: { scene: state.sceneId, shot: state.shotId },
    on,
    label,
    tooltip,
    supplies: ['panels'],
  };
}

/** A line row: dragged onto a panel to letter the line there. Refused on a frame. */
export function lineAction(state: PageState, line: CoverageLine): Offer {
  const shot = shotOf(state);
  const control = {
    ...startDrag('page.letter'),
    on     : `line/${line.id}`,
    label  : line.text,
    tooltip:
      'Drag onto a panel to letter this line there; Enter letters it in the selected panel. ' +
      'The page is drawn again on the next run.',
  };
  if (!shot?.panels?.length) {
    return {
      ...refuse(
        `${state.shotId || 'This shot'} is a single frame; pick a layout to make it a page first.`,
      ),
      ...control,
    };
  }
  return { ok: true, ...control };
}

/** The selected panel's framing pick; what the pick supplies is the list with that framing. */
export function framingAction(state: PageState): Offer {
  const n = (state.selected ?? 0) + 1;
  return {
    ok      : true,
    id      : 'story.setPanels',
    props   : { scene: state.sceneId, shot: state.shotId },
    on      : `panel/${n}/framing`,
    label   : 'Framing',
    tooltip : `How close the camera is in panel ${n}. The page is drawn again on the next run.`,
    supplies: ['panels'],
  };
}

/** The selected panel's camera note, committed on blur or Ctrl+S. */
export function cameraAction(state: PageState): Offer {
  const n = (state.selected ?? 0) + 1;
  return {
    ok      : true,
    id      : 'story.setPanels',
    props   : { scene: state.sceneId, shot: state.shotId },
    on      : `panel/${n}/camera`,
    label   : 'Camera',
    tooltip: `Where the camera stands in panel ${n} — an angle, a height. The page is drawn again on the next run.`,
    supplies: ['panels'],
  };
}

/** One of the shot's cast as a toggle: in the selected panel or out of it. */
export function castAction(state: PageState, characterId: string): Offer {
  const shot = shotOf(state);
  const index = state.selected ?? 0;
  const panel = shot?.panels?.[index];
  const present = panel?.subjects.some((s) => s.characterId === characterId) ?? false;
  const n = index + 1;
  return panelsOffer(
    state,
    {
      on     : `panel/${n}/cast/${characterId}`,
      label  : characterId,
      tooltip: present
        ? `Take ${characterId} out of panel ${n}.`
        : `Put ${characterId} in panel ${n}.`,
    },
    withCast(shot?.panels ?? [], index, characterId, !present),
  );
}

/** A cast member's pose or expression in the selected panel, committed on blur or Ctrl+S. */
export function subjectFieldAction(
  state: PageState,
  characterId: string,
  field: 'pose' | 'expression',
): Offer {
  const n = (state.selected ?? 0) + 1;
  return {
    ok      : true,
    id      : 'story.setPanels',
    props   : { scene: state.sceneId, shot: state.shotId },
    on      : `panel/${n}/cast/${characterId}/${field}`,
    label   : field === 'pose' ? 'Pose' : 'Expression',
    tooltip : `${characterId}’s ${field} in panel ${n}. The page is drawn again on the next run.`,
    supplies: ['panels'],
  };
}

/** The selected panel's art notes, committed on blur or Ctrl+S. */
export function notesAction(state: PageState): Offer {
  const n = (state.selected ?? 0) + 1;
  return {
    ok      : true,
    id      : 'story.setPanels',
    props   : { scene: state.sceneId, shot: state.shotId },
    on      : `panel/${n}/notes`,
    label   : 'Art notes',
    tooltip: `Direction for panel ${n} alone, appended to the page's prompt. The page is drawn again on the next run.`,
    supplies: ['panels'],
  };
}

/** The list a line row's Enter would write: the line lettered in the selected panel. */
export function enterLetters(state: PageState, lineId: string): PagePanel[] | null {
  const shot = shotOf(state);
  if (!shot?.panels || state.selected === null) return null;
  return letterLine(shot.panels, state.selected, lineId);
}

/** The header's one sentence about the render, or `''` when the page matched. */
export function verdictOf(shot: CoverageShot | undefined): string {
  if (!shot) return '';
  if (shot.failure) {
    return shot.failure.status === 'needs_human'
      ? 'Drawn, but the reviewers kept blocking it. Accept it as it stands, or change it and generate again.'
      : `The pipeline failed on it${shot.failure.error ? `: ${shot.failure.error}` : ''}`;
  }
  if (!shot.image) return 'Not drawn yet';
  return shot.layout ?? '';
}

/** The blocking defects the last review named, for the strip under a flagged render. */
export const defectsOf = (shot: CoverageShot | undefined): readonly string[] =>
  shot?.failure?.defects ?? [];

/** The slot address `pipeline.draw` and `art.setModel` take for the shot on screen. */
export const slotOf = (state: PageState): string => `shot:${state.sceneId}/${state.shotId}`;

/**
 * The Generate button: draw this shot, and nothing else, through `pipeline.draw`. The command
 * confirms, so the click opens its form with the cost. Before a render the button reads Generate;
 * after one, Regenerate, since the same command requeues a drawn slot first. A shot whose plate
 * or sheets are not drawn is refused with the resolver's sentence, which is what the command's
 * own check would say.
 */
export function generateAction(state: PageState): Offer {
  const shot = shotOf(state);
  const label = shot?.image ? 'Regenerate' : 'Generate';
  const control = {
    id: 'pipeline.draw',
    label,
    tooltip:
      `${shot?.image ? 'Draw this shot again' : 'Draw this shot'}: its own task and whatever it ` +
      'still needs upstream, nothing else in the project. Spends real image calls.',
  };
  if (!shot) return { ...refuse('No shot is on screen.'), ...control };
  if (shot.undrawable) return { ...refuse(shot.undrawable), ...control };
  return { ok: true, props: { slot: slotOf(state) }, ...control };
}

/**
 * Accept a render the reviewers kept blocking, as it stands. Only offered on such a render: an
 * accepted or undrawn page has nothing to accept. `asset.accept` is what the Asset editor's
 * Approve runs, so the two agree.
 */
export function acceptAction(state: PageState): Offer {
  const shot = shotOf(state);
  const control = { id: 'asset.accept', label: 'Accept as is' };
  if (!shot?.image || shot.failure?.status !== 'needs_human') {
    return { ...refuse('Nothing here is waiting on a human.'), ...control, tooltip: '' };
  }
  return {
    ok   : true,
    props: { hash: shot.image.hash },
    ...control,
    tooltip:
      'Keep this render despite the defects the reviewers named. It becomes the accepted frame ' +
      'for this shot.',
  };
}

/** The shot's image-model picker: `art.setModel` on the shot's own rung, the select supplying the id. */
export function shotModelAction(state: PageState): Offer {
  const shot = shotOf(state);
  const inherits = state.imageModel ?? 'the project’s';
  const control = {
    id      : 'art.setModel',
    label   : shot?.imageModel ?? `(${inherits})`,
    tooltip:
      'Which image model draws this shot, in place of the project’s. Pictures already drawn ' +
      `stay; Generate draws with it. Inherit takes ${inherits}.`,
    supplies: ['model'],
  };
  if (!shot) return { ...refuse('No shot is on screen.'), ...control };
  return { ok: true, props: { target: slotOf(state) }, ...control };
}

/** The shot's cast as the coverage strip's cast rules read it, or `undefined` off a shot. */
export function shotCastOf(state: PageState): ShotCast | undefined {
  const shot = shotOf(state);
  if (!shot) return undefined;
  const framed = [...shot.subjects];
  return {
    scene: state.sceneId,
    shot : shot.id,
    framed,
    spare   : (state.characters ?? []).filter((id) => !framed.includes(id)),
    required: shot.castOptional !== true,
    variant : shot.location,
    variants: [],
    ...(shot.imageModel === undefined ? {} : { imageModel: shot.imageModel }),
    projectModel: state.imageModel ?? '',
  };
}

/**
 * The shot's cast row: one button per framed character taking them out, and the select that puts
 * one in. Both are `story.setSubjects` with the whole list, the same controls Shot Coverage draws,
 * so a page's cast is edited where its panels are.
 */
export function shotCastActions(state: PageState): Offer[] {
  const cast = shotCastOf(state);
  if (!cast) return [];
  return [...cast.framed.map((id) => removeCastAction(cast, id)), addCastAction(cast)];
}

/** The header's summary: the layout name if any, the aspect, the panel count. */
export function summaryOf(shot: CoverageShot | undefined): string {
  if (!shot) return '';
  const panels = shot.panels ?? [];
  const layout = LAYOUTS.find((l) => inLayout(panels, l));
  const count = panels.length === 0 ? 'single frame' : `${panels.length} panels`;
  return [layout?.name, shot.aspect, count].filter((s): s is string => !!s).join(' · ');
}

/** The boxes the reviewer measured, for the overlay; none before a measured render. */
export const boxesOf = (shot: CoverageShot | undefined): readonly PanelBox[] =>
  shot?.panelBoxes ?? [];

/**
 * Every offer the Page editor draws: the layout row; per panel its hit area; the selected panel's
 * corners; per covered line its row; then the selected panel's fields and cast.
 */
export function controls(state: PageState): readonly Offer[] {
  const shot = shotOf(state);
  if (!shot) return [];
  const list: Offer[] = LAYOUTS.map((layout) => layoutAction(state, layout));
  list.push(generateAction(state), shotModelAction(state));
  if (shot.failure?.status === 'needs_human' && shot.image) list.push(acceptAction(state));
  list.push(...shotCastActions(state));
  const panels = shot.panels ?? [];
  panels.forEach((_, i) => list.push(panelAction(i)));
  const selected = selectedPanel(state);
  if (selected && state.selected !== null) {
    selected.shape.forEach((_, j) => list.push(cornerAction(state, state.selected!, j)));
  }
  for (const line of pageLines(state)) list.push(lineAction(state, line));
  if (selected) {
    list.push(framingAction(state), cameraAction(state));
    for (const characterId of shot.subjects) {
      list.push(castAction(state, characterId));
      if (selected.subjects.some((s) => s.characterId === characterId)) {
        list.push(
          subjectFieldAction(state, characterId, 'pose'),
          subjectFieldAction(state, characterId, 'expression'),
        );
      }
    }
    list.push(notesAction(state));
  }
  return list;
}
