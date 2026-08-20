/**
 * Writing allocated line ids down into a Fountain screenplay (allocated line ids, step 4).
 *
 * `splitScenes` allocates an id for every unmarked line on read, in memory. This module is
 * the other half: the explicit, opt-in writer that persists those allocations as
 * `[[line: L4]]` marks plus the scene's `[[nextline: n]]` allocator, so a later insertion
 * cannot re-point an existing shot's coverage.
 *
 * It is a sibling of `branchpatch.ts` and works the same way: only whole marker lines are added,
 * every other byte is left as authored, and the patched text is re-parsed and must reproduce the
 * same scenes, line for line, or the patch is discarded. The hazard that check exists for is a
 * note line above a `CHARACTER` cue, which turns the cue into an action paragraph and silently
 * un-speaks the dialogue below it.
 */
import type { Diagnostic, Scene } from '@vn/types';
import { parseBranchMarker, parseFountain, type FountainScript } from '@vn/parse';
import { canonicalScenes } from './canonical.js';
import { splitScenes } from './scenes.js';

/** The patched source plus anything that went wrong. On any error the text is unchanged. */
export interface LineIdPatchResult {
  text: string;
  /** How many `[[line:]]` marks were written; 0 means every line was already marked. */
  assigned: number;
  diagnostics: Diagnostic[];
}

interface RawLine {
  text: string;
  eol: string;
}

/** One line-bearing element, tied back to the source line it occupies. */
interface Slot {
  scene: Scene;
  /** Index into `scene.lines`. */
  index: number;
  /** Source line of the element's text. */
  line: number;
  marked: boolean;
  /**
   * True when the mark has to go on the element's own line rather than above it. Only an
   * unforced transition (`CUT TO:`) needs this: the parser recognizes it by the blank line
   * above, which a mark would fill, turning the transition into an action paragraph.
   */
  inline: boolean;
}

/** The element types `splitScenes` turns into `SceneLine`s, in the same order it sees them. */
const LINE_BEARING = new Set([
  'action',
  'dialogue',
  'parenthetical',
  'transition',
  'lyric',
  'centered',
]);

function err(code: string, message: string, where?: string): Diagnostic {
  return { severity: 'error', code, message, ...(where ? { where } : {}) };
}

/** Split into lines that remember their own terminator, so a rejoin is byte-exact. */
function splitLines(src: string): RawLine[] {
  const out: RawLine[] = [];
  let i = 0;
  while (i < src.length) {
    let j = i;
    while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
    let eol = '';
    if (j < src.length) eol = src[j] === '\r' && src[j + 1] === '\n' ? '\r\n' : (src[j] as string);
    out.push({ text: src.slice(i, j), eol });
    i = j + eol.length;
  }
  return out;
}

/** The local part of a composed `${sceneId}:L<n>` line id. */
function localOf(id: string): string {
  const colon = id.lastIndexOf(':');
  return colon < 0 ? id : id.slice(colon + 1);
}

/**
 * Walk the element list the way `splitScenes` does, recording where each line-bearing
 * element sits and whether a `[[line:]]` mark already claimed it. Mirrors that function's
 * pending-mark rule exactly, which is why it reads the parser's elements rather than
 * re-classifying raw text.
 */
function scan(
  script: FountainScript,
  scenes: Scene[],
  lines: RawLine[],
): { slots: Slot[]; anchors: Map<Scene, number>; allocatorLines: Map<Scene, number> } {
  const slots: Slot[] = [];
  const anchors = new Map<Scene, number>();
  const allocatorLines = new Map<Scene, number>();
  let scene: Scene | undefined;
  let index = 0;
  let pending = false;

  for (const el of script.elements) {
    if (el.type === 'scene_heading') {
      scene = scenes[anchors.size];
      index = 0;
      pending = false;
      if (scene) anchors.set(scene, el.line);
      continue;
    }
    if (!scene) continue;
    if (el.type === 'note') {
      const marker = parseBranchMarker(el.text);
      if (marker?.kind === 'line' && !pending) pending = true;
      else if (marker?.kind === 'nextline') allocatorLines.set(scene, el.line);
      else if (marker?.kind === 'scene') anchors.set(scene, el.line);
      continue;
    }
    if (LINE_BEARING.has(el.type)) {
      // An unforced `CUT TO:` is recognized by the blanks around it; only the forced `>` form
      // survives a marker line above it.
      const forced = (lines[el.line]?.text ?? '').trimStart().startsWith('>');
      const inline = el.type === 'transition' && !forced;
      slots.push({ scene, index: index++, line: el.line, marked: pending, inline });
      pending = false;
    }
  }
  return { slots, anchors, allocatorLines };
}

/**
 * The element list with the marks this writer adds removed, so the parse before a patch and the
 * parse after it are comparable. Catches damage the scene projection cannot see (a broken
 * transition or heading) because those elements never become `SceneLine`s.
 */
function skeleton(script: FountainScript): string {
  return JSON.stringify(
    script.elements
      .filter((el) => {
        if (el.type !== 'note') return true;
        const kind = parseBranchMarker(el.text)?.kind;
        return kind !== 'line' && kind !== 'nextline';
      })
      .map((el) => ({ ...el, line: 0 })),
  );
}

/**
 * Write every allocated line id into `text` as a `[[line:]]` mark, plus each touched scene's
 * `[[nextline:]]` allocator. `sceneId` limits the work to one scene; omitted means all.
 *
 * Marks are inserted directly above the element's own text — for dialogue and parentheticals
 * that is inside the block, after the `CHARACTER` cue, which is the only placement that does
 * not un-speak the line. The one exception is an unforced `CUT TO:` transition, whose mark
 * rides on its own line (see {@link Slot.inline}). Running it twice is a no-op.
 */
export function assignLineIds(text: string, sceneId?: string): LineIdPatchResult {
  const unchanged = (diagnostics: Diagnostic[]): LineIdPatchResult => ({
    text,
    assigned: 0,
    diagnostics,
  });

  const script = parseFountain(text);
  const before = splitScenes(script);
  const errors = before.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) return unchanged(errors);

  const targets = sceneId ? before.scenes.filter((s) => s.id === sceneId) : before.scenes;
  if (sceneId && targets.length === 0) {
    return unchanged([err('line_ids_scene', `no scene '${sceneId}' in the screenplay`, sceneId)]);
  }

  const lines = splitLines(text);
  const { slots, anchors, allocatorLines } = scan(script, before.scenes, lines);
  for (const scene of before.scenes) {
    const found = slots.filter((s) => s.scene === scene).length;
    if (found !== scene.lines.length || !anchors.has(scene)) {
      return unchanged([
        err(
          'line_ids_scan',
          `scene '${scene.id}' has ${scene.lines.length} line(s) but ${found} were located in ` +
            `the source; refusing to patch`,
          scene.id,
        ),
      ]);
    }
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const inserts = new Map<number, string[]>();
  const rewritten = new Map<number, string>();
  const addAfter = (line: number, added: string): void =>
    void inserts.set(line, [...(inserts.get(line) ?? []), added]);
  const indentOf = (line: number): string => /^\s*/.exec(lines[line]?.text ?? '')?.[0] ?? '';

  let assigned = 0;
  for (const scene of targets) {
    for (const slot of slots) {
      if (slot.scene !== scene || slot.marked) continue;
      const target = scene.lines[slot.index];
      if (!target) continue;
      const mark = `[[line: ${localOf(target.id)}]]`;
      if (slot.inline) {
        // The mark rides on the element's own line: notes are stripped before the line is
        // classified, so the blanks the element depends on are left where they were.
        const current = lines[slot.line]?.text ?? '';
        rewritten.set(slot.line, current.replace(/^(\s*)/, `$1${mark}`));
      } else {
        // insert before the element by anchoring to the previous line: the output pass appends
        // after a line, and the element's own line must stay below its mark
        addAfter(slot.line - 1, `${indentOf(slot.line)}${mark}`);
      }
      assigned++;
    }

    const mark = `[[nextline: ${scene.nextLineId ?? 1}]]`;
    const at = allocatorLines.get(scene);
    if (at === undefined) {
      addAfter(anchors.get(scene) as number, mark);
    } else {
      const current = lines[at]?.text ?? '';
      const replaced = current.replace(/\[\[\s*nextline\s*:[^\]]*\]\]/i, mark);
      if (replaced !== current) rewritten.set(at, replaced);
    }
  }

  if (assigned === 0 && rewritten.size === 0 && inserts.size === 0) {
    return { text, assigned: 0, diagnostics: [] };
  }

  const out: string[] = [];
  for (let i = -1; i < lines.length; i++) {
    const line = lines[i];
    if (line) out.push((rewritten.get(i) ?? line.text) + line.eol);
    const added = inserts.get(i);
    if (added) {
      // Appending after a final line with no trailing newline has to add one.
      if (line && line.eol === '' && out.length > 0) out[out.length - 1] += eol;
      for (const added_ of added) out.push(added_ + eol);
    }
  }
  const patched = out.join('');

  const reparsed = parseFountain(patched);
  const after = splitScenes(reparsed);
  if (
    after.diagnostics.length > 0 ||
    canonicalScenes(after.scenes) !== canonicalScenes(before.scenes) ||
    skeleton(reparsed) !== skeleton(script)
  ) {
    return unchanged([
      err(
        'line_ids_verify',
        're-parsing the marked screenplay did not reproduce the same scenes and lines; ' +
          'the file was left unchanged',
      ),
    ]);
  }

  return { text: patched, assigned, diagnostics: [] };
}
