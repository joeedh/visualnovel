/**
 * Surgical branch-marker patching for a Fountain screenplay (story branch editor, Wave 1).
 *
 * `sceneToFountain` is lossy by design — `Scene.body` is flattened prose, so re-serializing a
 * scene destroys cues, parentheticals and formatting. Rewiring a branch must therefore not go
 * through it. This module rewrites **only** `[[choice: …]]` and `[[next: …]]` note lines,
 * leaving every other byte of the file exactly as authored.
 *
 * The safety net is total: after patching, the whole file is re-parsed and the resulting scene
 * list is compared against the intended one. Any divergence — a marker written into the wrong
 * scene, or a removed note line that leaves a blank above a heading the parser was previously
 * ignoring — discards the patch and returns a diagnostic. A branch edit cannot silently
 * corrupt a screenplay.
 */
import type { Choice, Diagnostic, Scene } from '@vn/types';
import { parseBranchMarker, parseFountain } from '@vn/parse';
import { splitScenes } from './scenes.js';

/**
 * A branch rewire for one scene. `choices` replaces the scene's full choice set; `next` sets
 * the linear continuation, or clears it when `null`. An omitted field is left untouched.
 */
export interface SceneBranchEdit {
  sceneId: string;
  choices?: Choice[];
  next?: string | null;
}

/** The patched source plus anything that went wrong. On any error the text is unchanged. */
export interface BranchPatchResult {
  text: string;
  diagnostics: Diagnostic[];
}

// Mirrors `SCENE_PREFIX` in `@vn/parse`'s fountain.ts. Duplicated rather than exported from
// there: this is one caller's need, and the parser is on the hot path for every consumer.
const SCENE_PREFIX = /^(int\.?\/ext\.?|int\.?|ext\.?|est\.?|i\/e)[ .]/i;
const NOTE = /\[\[([\s\S]*?)\]\]/g;

type MarkerKind = 'choice' | 'next';

interface RawLine {
  text: string;
  eol: string;
}

interface Occurrence {
  line: number;
  start: number;
  end: number;
  kind: MarkerKind;
}

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

/**
 * Blank out boneyard blocks while preserving length and line breaks. The parser *deletes*
 * them, which can join two lines; masking keeps offsets aligned instead. The two disagree
 * only when a boneyard straddles a line break next to a heading, and the heading-count check
 * below turns that into a refusal rather than a mis-patch.
 */
function maskBoneyard(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ' '));
}

function stripNotes(line: string): string {
  return line.replace(/\[\[[\s\S]*?\]\]/g, '');
}

/**
 * Line indices of every scene heading, using the parser's own rules: a forced `.heading` or a
 * known INT./EXT. prefix, tested against the note-stripped line, preceded by a blank line.
 * Blankness is tested on the *raw* line — a note-only line is not blank to the parser, which
 * is why removing one can change how the next line reads.
 */
function findHeadings(masked: RawLine[]): number[] {
  let restStart = 0;
  if (/^[A-Za-z][A-Za-z ]*:/.test(masked[0]?.text ?? '')) {
    let i = 0;
    for (; i < masked.length; i++) {
      if ((masked[i]?.text ?? '').trim() === '') {
        i++;
        break;
      }
    }
    restStart = i;
  }
  const isBlank = (idx: number): boolean =>
    idx < restStart || idx >= masked.length || (masked[idx]?.text ?? '').trim() === '';

  const headings: number[] = [];
  for (let i = restStart; i < masked.length; i++) {
    const t = stripNotes(masked[i]?.text ?? '').trim();
    const forced = t.startsWith('.') && !t.startsWith('..');
    if ((forced || SCENE_PREFIX.test(t)) && isBlank(i - 1)) headings.push(i);
  }
  return headings;
}

/** Every branch marker on one line, with the character range it occupies. */
function markersOn(line: string, index: number): { occ: Occurrence[]; scene: boolean } {
  const occ: Occurrence[] = [];
  let scene = false;
  NOTE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NOTE.exec(line)) !== null) {
    const marker = parseBranchMarker(m[1] ?? '');
    if (!marker) continue;
    if (marker.kind === 'scene') scene = true;
    else occ.push({ line: index, start: m.index, end: m.index + m[0].length, kind: marker.kind });
  }
  return { occ, scene };
}

/** Reject anything that cannot survive `parseBranchMarker`, before a byte is written. */
function validate(edits: SceneBranchEdit[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (seen.has(edit.sceneId)) {
      out.push(
        err('branch_patch_duplicate', `two edits target scene '${edit.sceneId}'`, edit.sceneId),
      );
    }
    seen.add(edit.sceneId);
    const gotos = [
      ...(edit.choices ?? []).map((c) => c.goto),
      ...(edit.next != null ? [edit.next] : []),
    ];
    for (const goto of gotos) {
      if (!goto.trim() || /\s/.test(goto) || goto.includes('[[') || goto.includes(']]')) {
        out.push(err('branch_patch_goto', `'${goto}' is not a usable scene id`, edit.sceneId));
      }
    }
    for (const choice of edit.choices ?? []) {
      const label = choice.label.trim();
      if (!label) {
        out.push(
          err('branch_patch_label', `choice -> ${choice.goto} has an empty label`, edit.sceneId),
        );
      } else if (/[\r\n]/.test(label) || label.includes('[[') || label.includes(']]')) {
        out.push(
          err('branch_patch_label', `choice label '${label}' cannot be written`, edit.sceneId),
        );
      }
    }
  }
  return out;
}

/** The scene list the caller asked for, as a canonical string for comparison. */
function canonical(scenes: Scene[]): string {
  return JSON.stringify(
    scenes.map((s) => ({
      id: s.id,
      location: s.location,
      synopsis: s.synopsis ?? null,
      body: s.body,
      characters: s.characters,
      lines: s.lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        speaker: l.speaker ?? null,
        text: l.text,
      })),
      choices: s.choices.map((c) => ({ label: c.label, goto: c.goto })),
      next: s.next ?? null,
    })),
  );
}

/**
 * Apply branch rewires to a Fountain source, atomically. All edits are resolved against a
 * single scan, so two edits to the same scene are a caller error rather than a last-writer
 * race, and a failure anywhere leaves the text byte-identical.
 *
 * Choice labels are written quoted (`[[choice: "…" -> id]]`) and trimmed, matching
 * `sceneToFountain` so hand-authored and tool-authored files converge. A label containing
 * `]]` or a newline cannot round-trip and is rejected.
 *
 * Assumes a single screenplay file, which is what `@vn/store`'s worktree reads
 * (`fountain[0]`). Multi-file support would need a file argument here.
 */
export function applySceneBranchEdit(text: string, edits: SceneBranchEdit[]): BranchPatchResult {
  const unchanged = (diagnostics: Diagnostic[]): BranchPatchResult => ({ text, diagnostics });

  const invalid = validate(edits);
  if (invalid.length > 0) return unchanged(invalid);
  if (edits.length === 0) return { text, diagnostics: [] };

  const scenes = splitScenes(parseFountain(text)).scenes;
  const lines = splitLines(text);
  const masked = splitLines(maskBoneyard(text));
  const headings = findHeadings(masked);

  if (headings.length !== scenes.length) {
    return unchanged([
      err(
        'branch_patch_scan',
        `found ${headings.length} scene heading(s) in the source but the parser produced ` +
          `${scenes.length} scene(s); refusing to patch`,
      ),
    ]);
  }

  const byId = new Map(scenes.map((s, i) => [s.id, i]));
  const missing = edits.filter((e) => !byId.has(e.sceneId));
  if (missing.length > 0) {
    return unchanged(
      missing.map((e) =>
        err('branch_patch_scene', `no scene '${e.sceneId}' in the screenplay`, e.sceneId),
      ),
    );
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const deleted = new Set<number>();
  const rewritten = new Map<number, string>();
  const inserts = new Map<number, string[]>();

  for (const edit of edits) {
    const index = byId.get(edit.sceneId) as number;
    const from = headings[index] as number;
    const to = index + 1 < headings.length ? (headings[index + 1] as number) - 1 : lines.length - 1;

    const occurrences: Occurrence[] = [];
    let sceneMarkerLine: number | undefined;
    for (let i = from; i <= to; i++) {
      const { occ, scene } = markersOn(masked[i]?.text ?? '', i);
      occurrences.push(...occ);
      if (scene && sceneMarkerLine === undefined) sceneMarkerLine = i;
    }

    const kinds: MarkerKind[] = [];
    if (edit.choices !== undefined) kinds.push('choice');
    if (edit.next !== undefined) kinds.push('next');

    const doomed = occurrences.filter((o) => kinds.includes(o.kind));
    const firstOf = (kind: MarkerKind): number | undefined =>
      occurrences.find((o) => o.kind === kind)?.line;
    const lastOf = (kind: MarkerKind): number | undefined =>
      occurrences.filter((o) => o.kind === kind).at(-1)?.line;
    const indentOf = (kind: MarkerKind): string => {
      const line = firstOf(kind);
      if (line === undefined) return '';
      return /^\s*/.exec(lines[line]?.text ?? '')?.[0] ?? '';
    };

    // Remove the markers being replaced, right to left so earlier ranges stay valid. A line
    // left holding only whitespace was a marker line and goes entirely; one with other
    // content on it keeps that content.
    const byLine = new Map<number, Occurrence[]>();
    for (const o of doomed) byLine.set(o.line, [...(byLine.get(o.line) ?? []), o]);
    for (const [line, occ] of byLine) {
      let content = rewritten.get(line) ?? lines[line]?.text ?? '';
      for (const o of [...occ].sort((a, b) => b.start - a.start)) {
        content = content.slice(0, o.start) + content.slice(o.end);
      }
      if (content.trim() === '') deleted.add(line);
      else rewritten.set(line, content);
    }

    const fallback = sceneMarkerLine ?? from;
    const addAfter = (line: number, text: string): void =>
      void inserts.set(line, [...(inserts.get(line) ?? []), text]);

    if (edit.choices !== undefined && edit.choices.length > 0) {
      const anchor = firstOf('choice') ?? fallback;
      const indent = indentOf('choice');
      for (const c of edit.choices) {
        addAfter(anchor, `${indent}[[choice: "${c.label.trim()}" -> ${c.goto}]]`);
      }
    }
    if (edit.next != null) {
      const anchor = firstOf('next') ?? lastOf('choice') ?? fallback;
      addAfter(anchor, `${indentOf('next')}[[next: ${edit.next}]]`);
    }
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as RawLine;
    if (!deleted.has(i)) out.push((rewritten.get(i) ?? line.text) + line.eol);
    const added = inserts.get(i);
    if (added) {
      // Appending after the final line of a file with no trailing newline has to add one.
      if (!deleted.has(i) && line.eol === '' && out.length > 0) out[out.length - 1] += eol;
      for (const text of added) out.push(text + eol);
    }
  }
  const patched = out.join('');

  const expected = scenes.map((s) => {
    const edit = edits.find((e) => e.sceneId === s.id);
    if (!edit) return s;
    return {
      ...s,
      choices: edit.choices?.map((c) => ({ label: c.label.trim(), goto: c.goto })) ?? s.choices,
      next: edit.next === undefined ? s.next : (edit.next ?? undefined),
    } satisfies Scene;
  });
  const actual = splitScenes(parseFountain(patched)).scenes;
  if (canonical(actual) !== canonical(expected)) {
    return unchanged([
      err(
        'branch_patch_verify',
        're-parsing the patched screenplay did not reproduce the intended scenes; ' +
          'the file was left unchanged',
      ),
    ]);
  }

  return { text: patched, diagnostics: [] };
}
