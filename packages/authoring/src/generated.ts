/**
 * The generated half of the agent's context (`AICONTEXT.generated.md`) — a map rather than
 * content: what characters, locations, scenes and bible notes exist, and which file each lives
 * in. No line of anything the author wrote appears here; the agent reads a file, or queries the
 * bible, for that. Pure projection + rendering, so the budget and truncation lines are testable
 * without a project on disk; {@link Workspace.writeGeneratedContext} is the impure half.
 */
import { relative } from 'node:path';
import type { BibleFile } from '@vn/bible';
import type { LoadedInputs } from '@vn/parse';
import type { CharacterStatus, ProjectModel } from '@vn/types';

/** Where the generated context lives, relative to the project root. */
export const GENERATED_CONTEXT_FILE = 'AICONTEXT.generated.md';

/**
 * The prefix that marks a file as ours. Matched instead of the whole banner so a later version of
 * the banner still recognizes a file this version wrote, rather than treating it as someone
 * else's and refusing to replace it.
 */
export const GENERATED_MARK = '<!-- vn:generated-context';

/** The banner every generated file opens with. See {@link GENERATED_MARK}. */
export const GENERATED_BANNER = `${GENERATED_MARK} v1 — written by workspace.reindex; edits here are lost. -->`;

/** How many characters the whole file may spend. */
export const DEFAULT_BUDGET = 8000;

/** True when `text` was written by the generator, and so may be overwritten or loaded. */
export function isGenerated(text: string): boolean {
  return text.trimStart().startsWith(GENERATED_MARK);
}

/** One character in the map: identity, where its sheet is, and its wardrobe. */
export interface MappedCharacter {
  id: string;
  name: string;
  status: CharacterStatus;
  file?: string;
  defaultOutfit: string;
  /** Outfit ids off the sheet, default first; empty when the sheet describes none. */
  outfits: string[];
}

/** One location in the map. `file` is absent for a location mined from a heading. */
export interface MappedLocation {
  id: string;
  name: string;
  mined: boolean;
  file?: string;
  variants: string[];
}

/** Where a scene goes: a labelled choice, or an unlabelled linear continuation. */
export interface MappedEdge {
  label?: string;
  goto: string;
}

/** One scene in the map — the story graph is these rows read together. */
export interface MappedScene {
  id: string;
  location: string;
  characters: string[];
  edges: MappedEdge[];
  reachable: boolean;
  file?: string;
}

/** Everything the generated file is rendered from. Built by {@link projectMap}. */
export interface ProjectMap {
  title: string;
  entry?: string;
  characters: MappedCharacter[];
  locations: MappedLocation[];
  scenes: MappedScene[];
  /** The bible's table of contents — metadata only, which is all `Bible.files()` returns. */
  bible: BibleFile[];
}

/** How much of each kind the file was built from; reported by the writer, not rendered as prose. */
export interface GeneratedCounts {
  characters: number;
  locations: number;
  scenes: number;
  bible: number;
}

/**
 * Project a built model plus the load it came from into the map. The file paths come from
 * `inputs`, never rebuilt from an id — a tagged entity lives wherever its file lives — and are
 * written relative to `root` with `/` separators, so the same project maps to the same bytes on
 * anyone's machine.
 */
export function projectMap(
  root: string,
  model: ProjectModel,
  inputs: LoadedInputs,
  bible: BibleFile[],
): ProjectMap {
  const rel = (file: string): string => relative(root, file).split('\\').join('/');
  const characterFiles = new Map(inputs.characterDocs.map((d) => [d.id, rel(d.file)]));
  const locationFiles = new Map(inputs.locationDocs.map((d) => [d.id, rel(d.file)]));
  const sceneFiles = new Map(inputs.sceneDocs.map((d) => [d.id, rel(d.file)]));

  const characters: MappedCharacter[] = [...model.characters.values()].map((c) => {
    // The default outfit leads the list whether or not the sheet describes it, because an outfit
    // id with no description is still an outfit
    const rest = c.outfits.map((o) => o.id).filter((id) => id !== c.defaultOutfit);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      ...(characterFiles.has(c.id) ? { file: characterFiles.get(c.id)! } : {}),
      defaultOutfit: c.defaultOutfit,
      outfits: c.defaultOutfit ? [c.defaultOutfit, ...rest] : rest,
    };
  });

  const locations: MappedLocation[] = [...model.locations.values()].map((l) => ({
    id: l.id,
    name: l.name,
    mined: l.mined,
    ...(locationFiles.has(l.id) ? { file: locationFiles.get(l.id)! } : {}),
    variants: l.variants.map((v) => v.id),
  }));

  const scenes: MappedScene[] = [...model.scenes.values()].map((s) => ({
    id: s.id,
    location: s.location,
    characters: s.characters,
    edges: s.choices.length
      ? s.choices.map((c) => ({ label: c.label, goto: c.goto }))
      : s.next
        ? [{ goto: s.next }]
        : [],
    reachable: model.reachable.has(s.id),
    ...(sceneFiles.has(s.id) ? { file: sceneFiles.get(s.id)! } : {}),
  }));

  return {
    title: model.title,
    ...(model.entry === undefined ? {} : { entry: model.entry }),
    characters,
    locations,
    scenes,
    bible,
  };
}

/** The counts a map was built from. */
export function countsOf(map: ProjectMap): GeneratedCounts {
  return {
    characters: map.characters.length,
    locations: map.locations.length,
    scenes: map.scenes.length,
    bible: map.bible.length,
  };
}

/**
 * A budgeted block: the heading always renders, rows may be dropped, and `more` reports how many
 * were dropped.
 */
interface Section {
  heading: string;
  rows: string[];
  more: (dropped: number) => string;
}

function characterRow(c: MappedCharacter): string {
  const parts = [`- ${c.id} "${c.name}" [${c.status}]`, c.file ?? '(no sheet)'];
  if (c.outfits.length) {
    const [first, ...rest] = c.outfits;
    parts.push(`outfits: ${[`${first} (default)`, ...rest].join(', ')}`);
  }
  return parts.join(' — ');
}

function locationRow(l: MappedLocation): string {
  const parts = [
    `- ${l.id} "${l.name}"`,
    l.mined ? 'mined from a heading; no sheet' : (l.file ?? '(no sheet)'),
  ];
  if (l.variants.length) parts.push(`variants: ${l.variants.join(', ')}`);
  return parts.join(' — ');
}

function edgeText(edges: MappedEdge[]): string {
  if (!edges.length) return 'end';
  if (edges.length === 1 && edges[0]!.label === undefined) return `next: ${edges[0]!.goto}`;
  const each = edges.map((e) => (e.label ? `"${e.label}" -> ${e.goto}` : e.goto));
  return `choices: ${each.join(', ')}`;
}

function sceneRow(s: MappedScene): string {
  const parts = [`- ${s.id} @${s.location}`];
  if (s.characters.length) parts.push(`cast: ${s.characters.join(', ')}`);
  parts.push(edgeText(s.edges));
  parts.push(s.file ?? '(no file)');
  return parts.join(' — ') + (s.reachable ? '' : ' [unreachable]');
}

function bibleRow(f: BibleFile): string {
  const parts = [`- ${f.file} "${f.title}"`];
  if (f.tags.length) parts.push(`[${f.tags.join(', ')}]`);
  // Six headings is enough to aim a query at, and the map does not carry a long note's whole
  // outline
  if (f.headings.length) {
    const shown = f.headings.slice(0, 6).join(', ');
    parts.push(f.headings.length > 6 ? `${shown}, …` : shown);
  }
  return parts.join(' — ');
}

/**
 * Render the map. `budget` caps the whole file; sections are paid for in order (cast, locations,
 * scenes, then the bible, which is the one that grows without bound), and a section that could
 * not print every row says how many it dropped and which tool answers the rest.
 */
export function renderGeneratedContext(map: ProjectMap, opts: { budget?: number } = {}): string {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const counts = countsOf(map);
  const out = [
    GENERATED_BANNER,
    '',
    `# Project map — ${map.title}`,
    '',
    `Generated by workspace.reindex from ${counts.characters} character(s), ` +
      `${counts.locations} location(s), ${counts.scenes} scene(s), ${counts.bible} bible note(s).`,
    'A map, not content: it says what exists and where it lives, never what a file says. Read a',
    'file for its text, and search_bible for anything under wiki/.',
  ];

  const sections: Section[] = [
    {
      heading: `## Characters (${counts.characters})`,
      rows: map.characters.map(characterRow),
      more: (n) => `… and ${n} more character(s); list_workspace lists them all.`,
    },
    {
      heading: `## Locations (${counts.locations})`,
      rows: map.locations.map(locationRow),
      more: (n) => `… and ${n} more location(s); list_workspace lists them all.`,
    },
    {
      heading: `## Scenes (${counts.scenes})${map.entry ? ` — entry: ${map.entry}` : ''}`,
      rows: map.scenes.map(sceneRow),
      more: (n) => `… and ${n} more scene(s); list_workspace lists them all.`,
    },
    {
      heading: `## Story bible (${counts.bible} note(s) under wiki/)`,
      rows: map.bible.map(bibleRow),
      more: (n) => `… and ${n} more note(s); use search_bible.`,
    },
  ];

  for (const section of sections) {
    if (!section.rows.length) continue;
    let used = out.join('\n').length;
    const kept: string[] = [];
    for (const row of section.rows) {
      if (used + row.length + 1 > budget) break;
      kept.push(row);
      used += row.length + 1;
    }
    // The heading and its count always render, even when every row was dropped: a section that
    // says it is partial is what sends the agent to the tool that lists the rest
    out.push('', section.heading, '', ...kept);
    const dropped = section.rows.length - kept.length;
    if (dropped > 0) out.push(section.more(dropped));
  }

  return `${out.join('\n')}\n`;
}
