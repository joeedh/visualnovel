import type { Choice, Diagnostic, Scene, SceneLine } from '@vn/types';
import { parseBranchMarker, type FountainScript } from '@vn/parse';
import { slug } from './slug.js';

/** A location reference mined from a scene heading (report §P1 deterministic baseline). */
export interface MinedLocation {
  id: string;
  name: string;
  variant: string;
}

/** Parse `INT. CLASSROOM - AFTERNOON` into a location id/name + time-of-day variant. */
export function parseHeading(heading: string): MinedLocation {
  const withoutPrefix = heading.replace(/^(int\.?\/ext\.?|int\.?|ext\.?|est\.?|i\/e)[ .]+/i, '');
  const parts = withoutPrefix.split(/\s+-\s+/);
  const name = (parts[0] ?? withoutPrefix).trim();
  const variant = parts.length > 1 ? slug(parts.slice(1).join(' ')) : 'day';
  return { id: slug(name), name: name.replace(/\s+/g, ' ').trim(), variant: variant || 'day' };
}

/** What one `splitScenes` pass recovered from a script. */
export interface SplitResult {
  scenes: Scene[];
  mined: MinedLocation[];
  /** Line-id problems (aliased and dangling marks); an error here means coverage is ambiguous. */
  diagnostics: Diagnostic[];
}

/**
 * Split a Fountain script into scene graph nodes (report §6, §P5.1). Each scene heading
 * starts a node; branch markers inside the node supply its id, choices, and linear
 * `next`. The narrative body is retained for the later (generative) shot decomposition.
 *
 * Line ids are **honoured where marked and allocated where not**: `[[line: L4]]` names the
 * next line-bearing element, `[[nextline: n]]` is the scene's allocator, and anything
 * unmarked takes the next id from it. Reading never writes — a screenplay with no marks
 * allocates `L1..Ln` in document order, exactly what a positional stamp produced.
 */
export function splitScenes(script: FountainScript): SplitResult {
  const scenes: Scene[] = [];
  const mined: MinedLocation[] = [];
  const diagnostics: Diagnostic[] = [];
  let current: Scene | null = null;
  let pendingSynopsis: string | undefined;
  const bodyLines: string[] = [];
  const cueNames = new Set<string>();
  const sceneIdOverrides = new Map<Scene, string>();
  /** Active speaker cue within the current scene; carried across the flattened element list. */
  let currentSpeaker: string | undefined;
  /** A `[[line:]]` mark waiting for the element it names; carried the same way. */
  let pendingLineId: string | undefined;
  /** Marks that never found an element, reported once the scene's final id is known. */
  const dangling = new Map<Scene, string[]>();

  const addDangling = (scene: Scene, id: string): void => {
    dangling.set(scene, [...(dangling.get(scene) ?? []), id]);
  };

  const flush = (): void => {
    if (current) {
      if (pendingLineId !== undefined) addDangling(current, pendingLineId);
      current.body = bodyLines.join('\n').trim();
      current.characters = [...cueNames];
      scenes.push(current);
    }
    bodyLines.length = 0;
    cueNames.clear();
    currentSpeaker = undefined;
    pendingLineId = undefined;
  };

  /**
   * Append a structured line to the current scene, consuming any pending mark. `id` holds
   * the bare local part until the final pass composes `${scene.id}:<local>`; unmarked lines
   * carry `''` and are allocated there, once every mark in the scene is known.
   */
  const pushLine = (line: Omit<SceneLine, 'id'>): void => {
    if (!current) return;
    current.lines.push({ id: pendingLineId ?? '', ...line });
    pendingLineId = undefined;
  };

  let index = 0;
  for (const el of script.elements) {
    switch (el.type) {
      case 'scene_heading': {
        flush();
        const loc = parseHeading(el.text);
        mined.push(loc);
        index += 1;
        current = {
          id: el.sceneNumber ? slug(el.sceneNumber) : `${loc.id}_${index}`,
          location: loc.id,
          characters: [],
          synopsis: pendingSynopsis,
          body: '',
          lines: [],
          choices: [],
          next: undefined,
          shots: [],
        };
        // Stash the heading's intended variant on the scene via the first mined entry.
        current.location = loc.id;
        pendingSynopsis = undefined;
        break;
      }
      case 'synopsis':
        if (current) current.synopsis = el.text;
        else pendingSynopsis = el.text;
        break;
      case 'note': {
        const marker = parseBranchMarker(el.text);
        if (!marker || !current) break;
        if (marker.kind === 'scene') sceneIdOverrides.set(current, marker.id);
        else if (marker.kind === 'choice')
          current.choices.push({ label: marker.label, goto: marker.goto } satisfies Choice);
        else if (marker.kind === 'next') current.next = marker.goto;
        else if (marker.kind === 'nextline') current.nextLineId = marker.value;
        else if (marker.kind === 'line') {
          // Two marks with nothing between them: the first keeps the element, the second
          // has nothing to name.
          if (pendingLineId !== undefined) addDangling(current, marker.id);
          else pendingLineId = marker.id;
        }
        break;
      }
      case 'character':
        cueNames.add(el.name);
        currentSpeaker = el.name;
        if (current) bodyLines.push(`${el.name}:`);
        break;
      case 'dialogue':
        if (current) {
          bodyLines.push(el.text);
          pushLine({ kind: 'dialogue', speaker: currentSpeaker, text: el.text });
        }
        break;
      case 'parenthetical':
        if (current) {
          bodyLines.push(el.text);
          pushLine({ kind: 'parenthetical', speaker: currentSpeaker, text: el.text });
        }
        break;
      case 'action':
        if (current) {
          bodyLines.push(el.text);
          // Action after a cue is a stage direction for that speaker; otherwise narration.
          pushLine(
            currentSpeaker
              ? { kind: 'action', speaker: currentSpeaker, text: el.text }
              : { kind: 'narration', text: el.text },
          );
        }
        break;
      default:
        break;
    }
  }
  flush();

  // Apply [[scene: id]] overrides after splitting so ids are stable, then resolve each line's
  // id (done here so ids reflect the overridden scene id, and so every mark in the scene is
  // known before a single one is allocated — an allocated id must never land on a marked one).
  for (const scene of scenes) {
    const override = sceneIdOverrides.get(scene);
    if (override) scene.id = override;

    const marked = new Map<string, number>();
    let maxMarked = 0;
    for (const line of scene.lines) {
      if (!line.id) continue;
      marked.set(line.id, (marked.get(line.id) ?? 0) + 1);
      const m = /^L(\d+)$/.exec(line.id);
      if (m) maxMarked = Math.max(maxMarked, Number(m[1]));
    }
    for (const [id, count] of marked) {
      if (count > 1) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate_line_id',
          message: `scene "${scene.id}" marks ${count} lines with line id "${id}"; a shot covering it cannot say which`,
          where: scene.id,
        });
      }
    }

    // A stale [[nextline:]] is a bug, not a licence to reuse an id, so the mark is raised to
    // clear every id actually in use rather than being trusted as written.
    let next = Math.max(scene.nextLineId ?? 1, maxMarked + 1);
    for (const line of scene.lines) {
      line.id = `${scene.id}:${line.id || `L${next++}`}`;
    }
    scene.nextLineId = next;

    for (const id of dangling.get(scene) ?? []) {
      diagnostics.push({
        severity: 'error',
        code: 'dangling_line_id',
        message: `[[line: ${id}]] in scene "${scene.id}" names no line`,
        where: scene.id,
      });
    }
  }

  return { scenes, mined, diagnostics };
}
