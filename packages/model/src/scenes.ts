import type { Choice, Diagnostic, HeadingPrefix, Scene, SceneLine } from '@vn/types';
import { parseBranchMarker, type FountainScript } from '@vn/parse';
import { slug } from './slug.js';

/** A location reference mined from a scene heading (report §P1 deterministic baseline). */
export interface MinedLocation {
  id: string;
  name: string;
  variant: string;
}

const HEADING_PREFIX = /^(int\.?\/ext\.?|int\.?|ext\.?|est\.?|i\/e)[ .]+/i;

/** Parse `INT. CLASSROOM - AFTERNOON` into a location id/name + time-of-day variant. */
export function parseHeading(heading: string): MinedLocation {
  const withoutPrefix = heading.replace(HEADING_PREFIX, '');
  const parts = withoutPrefix.split(/\s+-\s+/);
  const name = (parts[0] ?? withoutPrefix).trim();
  const variant = parts.length > 1 ? slug(parts.slice(1).join(' ')) : 'day';
  return { id: slug(name), name: name.replace(/\s+/g, ' ').trim(), variant: variant || 'day' };
}

/**
 * The heading's interior/exterior prefix in canonical spelling, or `undefined` when it has
 * none — a forced `.HEADING`. Kept on the scene because `sceneToFountain` writes the heading
 * back and a reconstructed one is wrong about the thing the plate is generated from.
 */
export function headingPrefixOf(heading: string): HeadingPrefix | undefined {
  const raw = HEADING_PREFIX.exec(heading)?.[1]?.toLowerCase().replace(/\./g, '');
  if (!raw) return undefined;
  if (raw === 'int/ext') return 'INT./EXT.';
  if (raw === 'i/e') return 'I/E';
  if (raw === 'ext') return 'EXT.';
  if (raw === 'est') return 'EST.';
  return 'INT.';
}

/** What one `splitScenes` pass recovered from a script. */
export interface SplitResult {
  scenes: Scene[];
  mined: MinedLocation[];
  /** Line-id problems (aliased and dangling marks); an error here means coverage is ambiguous. */
  diagnostics: Diagnostic[];
}

/** Options for {@link splitScenes}. */
export interface SplitOptions {
  /**
   * Force the id of every scene found. A chunk file's id is its filename, and forcing it here
   * rather than renaming the scene afterwards is what makes its line ids come out
   * `${id}:L<n>`. A caller that passes it must reject a body with more than one heading — the
   * scenes would collide on the id.
   */
  sceneId?: string;
}

/**
 * Split a Fountain script into scene graph nodes (report §6, §P5.1). Each scene heading
 * starts a node; branch markers inside the node supply its id, choices, and linear
 * `next`. The prose is retained as {@link Scene.lines} — the only form it is kept in.
 *
 * Every element that can carry art becomes a {@link SceneLine} — dialogue, parentheticals,
 * action, transitions, lyrics and centered text. Only `section` and `page_break` are dropped,
 * deliberately (see the `default` below).
 *
 * Line ids are **honoured where marked and allocated where not**: `[[line: L4]]` names the
 * next line-bearing element, `[[nextline: n]]` is the scene's allocator, and anything
 * unmarked takes the next id from it. Reading never writes — a screenplay with no marks
 * allocates `L1..Ln` in document order, exactly what a positional stamp produced.
 */
export function splitScenes(script: FountainScript, opts: SplitOptions = {}): SplitResult {
  const scenes: Scene[] = [];
  const mined: MinedLocation[] = [];
  const diagnostics: Diagnostic[] = [];
  let current: Scene | null = null;
  let pendingSynopsis: string | undefined;
  const cueNames = new Set<string>();
  const sceneIdOverrides = new Map<Scene, string>();
  /** Active speaker cue within the current scene; carried across the flattened element list. */
  let currentSpeaker: string | undefined;
  /** A `[[line:]]` mark waiting for the element it names; carried the same way. */
  let pendingLineId: string | undefined;
  /** Marks that never found an element, reported once the scene's final id is known. */
  const dangling = new Map<Scene, string[]>();
  /**
   * Notes no marker parses out of, with the scene they sat in — `null` for one stranded above the
   * first heading, which is exactly the kind worth saying. Classified in the final pass rather
   * than here, because that is where `[[scene:]]` overrides land and a diagnostic stamped earlier
   * could carry an id the scene no longer has.
   */
  const strayNotes: { scene: Scene | null; text: string }[] = [];

  const addDangling = (scene: Scene, id: string): void => {
    dangling.set(scene, [...(dangling.get(scene) ?? []), id]);
  };

  const flush = (): void => {
    if (current) {
      if (pendingLineId !== undefined) addDangling(current, pendingLineId);
      current.characters = [...cueNames];
      scenes.push(current);
    }
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
    // A cue's speaker survives only its own dialogue block. Notes are interleaved into blocks
    // and must not break it; everything else ends it. Left standing, the speaker attributed
    // narration three exchanges later to whoever spoke last.
    if (el.type !== 'dialogue' && el.type !== 'parenthetical' && el.type !== 'note') {
      currentSpeaker = undefined;
    }
    switch (el.type) {
      case 'scene_heading': {
        flush();
        const loc = parseHeading(el.text);
        mined.push(loc);
        index += 1;
        current = {
          id: el.sceneNumber ? slug(el.sceneNumber) : `${loc.id}_${index}`,
          location: loc.id,
          locationVariant: loc.variant,
          headingPrefix: headingPrefixOf(el.text),
          characters: [],
          synopsis: pendingSynopsis,
          lines: [],
          choices: [],
          next: undefined,
          shots: [],
        };
        pendingSynopsis = undefined;
        break;
      }
      case 'synopsis':
        if (current) current.synopsis = el.text;
        else pendingSynopsis = el.text;
        break;
      case 'note': {
        const marker = parseBranchMarker(el.text);
        if (!marker) {
          strayNotes.push({ scene: current, text: el.text.trim() });
          break;
        }
        if (!current) break;
        if (marker.kind === 'scene') sceneIdOverrides.set(current, marker.id);
        else if (marker.kind === 'choice')
          current.choices.push({ label: marker.label, goto: marker.goto } satisfies Choice);
        else if (marker.kind === 'next') current.next = marker.goto;
        else if (marker.kind === 'outfit') {
          // Scene-scoped wherever the marker sits, so a later one for the same character is a
          // correction rather than a change of clothes partway down the page.
          current.outfits = { ...current.outfits, [marker.characterId]: marker.outfit };
        } else if (marker.kind === 'nextline') current.nextLineId = marker.value;
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
        break;
      case 'dialogue':
        pushLine({ kind: 'dialogue', speaker: currentSpeaker, text: el.text });
        break;
      case 'parenthetical':
        pushLine({ kind: 'parenthetical', speaker: currentSpeaker, text: el.text });
        break;
      case 'action':
        pushLine({ kind: 'narration', text: el.text });
        break;
      case 'transition':
      case 'lyric':
      case 'centered':
        pushLine({ kind: el.type, text: el.text });
        break;
      default:
        // `section` and `page_break` are dropped deliberately: they mean nothing to the
        // pipeline, and a line kind no shot would ever cover is worse than losing them.
        break;
    }
  }
  flush();

  // Apply [[scene: id]] overrides after splitting so ids are stable, then resolve each line's
  // id (done here so ids reflect the overridden scene id, and so every mark in the scene is
  // known before a single one is allocated — an allocated id must never land on a marked one).
  for (const scene of scenes) {
    const override = sceneIdOverrides.get(scene);
    if (opts.sceneId !== undefined) {
      // A chunk carries its id in front-matter, so a body marker cannot rename the file it
      // lives in. Warned about rather than obeyed or dropped in silence.
      if (override !== undefined && override !== opts.sceneId) {
        diagnostics.push({
          severity: 'warning',
          code: 'ignored_scene_marker',
          message: `[[scene: ${override}]] in scene "${opts.sceneId}" is ignored; a chunk's id is its filename`,
          where: opts.sceneId,
        });
      }
      scene.id = opts.sceneId;
    } else if (override) scene.id = override;

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

  for (const { scene, text } of strayNotes) {
    const classified = strayNoteDiagnostic(text);
    if (!classified) continue;
    const where = scene?.id ?? opts.sceneId;
    diagnostics.push({
      ...classified,
      message: `[[${text}]]${where ? ` (scene ${where})` : ''} ${classified.message}`,
      ...(where ? { where } : {}),
    });
  }

  return { scenes, mined, diagnostics };
}

/**
 * What a note no marker parses is worth saying, or nothing at all. Severity follows **consequence,
 * not confidence**: a `choice`/`next`/`line` that fails to parse silently loses a story-graph edge
 * or a shot's anchor, while `outfit`, `nextline` and `scene` each document a fallback to a plain
 * note in `parseBranchMarker`, so erroring on one would overrule a decision made there. A note with
 * no colon is ordinary Fountain prose and is not a failed anything.
 *
 * The text is the only handle anyone has: notes never become `SceneLine`s, so no line id addresses
 * one.
 */
function strayNoteDiagnostic(text: string): Omit<Diagnostic, 'where'> | null {
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const key = text.slice(0, colon).trim().toLowerCase();
  if (key === 'choice' || key === 'next' || key === 'goto' || key === 'line') {
    return {
      severity: 'error',
      code: 'unparsed_branch_marker',
      message: `is a ${key} marker that does not parse; the edge or anchor it names is lost, and it will be absent from the scene the next time it is written`,
    };
  }
  return {
    severity: 'warning',
    code: 'unknown_marker',
    message: `is not a branch marker; it will be absent from the scene the next time it is written`,
  };
}
