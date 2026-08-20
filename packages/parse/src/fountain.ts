/**
 * A pragmatic Fountain parser (report §P0; see docs/reference/fountain.md). It recognizes the
 * elements this project needs to mine locations and split scenes — scene headings,
 * action, character cues, dialogue, parentheticals, transitions, sections, synopses,
 * notes, lyrics, and page breaks — using blank-line + capitalization + prefix rules.
 *
 * It is intentionally not a pixel-perfect typesetting parser; it is a structural
 * extractor. Notes (`[[ ... ]]`) are preserved as elements because the branch-marker
 * layer (see ./branch.ts) lives inside them.
 */

export interface TitlePage {
  [key: string]: string;
}

/**
 * Every element records `line`: the zero-based index of the source line it came from, so a
 * surgical writer can patch beside an element without re-deriving where it is. Boneyard
 * blocks are blanked in place rather than deleted, which keeps those indices aligned with
 * the original text.
 */
export type FountainElement =
  | { type: 'scene_heading'; text: string; sceneNumber?: string; line: number }
  | { type: 'action'; text: string; line: number }
  | { type: 'character'; name: string; dual: boolean; line: number }
  | { type: 'dialogue'; text: string; line: number }
  | { type: 'parenthetical'; text: string; line: number }
  | { type: 'transition'; text: string; line: number }
  | { type: 'section'; depth: number; text: string; line: number }
  | { type: 'synopsis'; text: string; line: number }
  | { type: 'lyric'; text: string; line: number }
  | { type: 'centered'; text: string; line: number }
  | { type: 'note'; text: string; line: number }
  | { type: 'page_break'; line: number };

export interface FountainScript {
  title: TitlePage;
  elements: FountainElement[];
}

const SCENE_PREFIX = /^(int\.?\/ext\.?|int\.?|ext\.?|est\.?|i\/e)[ .]/i;

/**
 * Remove boneyard blocks (slash-star ... star-slash, may span lines), keeping their line
 * breaks so every element's `line` still indexes the original source.
 */
function stripBoneyard(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n\r]/g, ''));
}

/** Pull standalone note lines (`[[ … ]]`) out as their own elements. */
function extractNotes(line: string): { stripped: string; notes: string[] } {
  const notes: string[] = [];
  const stripped = line.replace(/\[\[([\s\S]*?)\]\]/g, (_m, inner: string) => {
    notes.push(inner.trim());
    return '';
  });
  return { stripped, notes };
}

function parseTitlePage(lines: string[]): { title: TitlePage; rest: string[] } {
  const title: TitlePage = {};
  // A title page exists only if the first non-empty line is a `Key: value` pair.
  if (!/^[A-Za-z][A-Za-z ]*:/.test(lines[0] ?? '')) return { title, rest: lines };
  let i = 0;
  let lastKey: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      break;
    }
    const m = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(line);
    if (m) {
      lastKey = (m[1] ?? '').trim().toLowerCase();
      title[lastKey] = (m[2] ?? '').trim();
    } else if (lastKey) {
      title[lastKey] = `${title[lastKey]}\n${line.trim()}`.trim();
    }
  }
  return { title, rest: lines.slice(i) };
}

/** Parse a Fountain document into a title page + ordered element list. */
export function parseFountain(input: string): FountainScript {
  const text = stripBoneyard(input).replace(/\r\n?/g, '\n');
  const allLines = text.split('\n');
  const { title, rest } = parseTitlePage(allLines);

  const elements: FountainElement[] = [];
  const lines = rest;
  const isBlank = (i: number): boolean =>
    i < 0 || i >= lines.length || (lines[i] ?? '').trim() === '';
  // Elements index the original document, so the title page's lines have to be added back.
  const titleLines = allLines.length - rest.length;

  let i = 0;
  const srcLine = (): number => titleLines + i;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const { stripped, notes } = extractNotes(raw);
    for (const n of notes) elements.push({ type: 'note', text: n, line: srcLine() });
    const line = stripped;
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }

    // Page break: 3+ '='.
    if (/^={3,}$/.test(trimmed)) {
      elements.push({ type: 'page_break', line: srcLine() });
      i++;
      continue;
    }
    // Section (#) and synopsis (=) — outline aids.
    if (trimmed.startsWith('#')) {
      const depth = (trimmed.match(/^#+/) ?? ['#'])[0].length;
      elements.push({
        type: 'section',
        depth,
        text: trimmed.replace(/^#+\s*/, ''),
        line: srcLine(),
      });
      i++;
      continue;
    }
    if (trimmed.startsWith('=') && !/^={3,}$/.test(trimmed)) {
      elements.push({ type: 'synopsis', text: trimmed.replace(/^=\s*/, ''), line: srcLine() });
      i++;
      continue;
    }
    if (trimmed.startsWith('~')) {
      elements.push({ type: 'lyric', text: trimmed.slice(1).trim(), line: srcLine() });
      i++;
      continue;
    }
    // Centered: >text<
    if (/^>.*<$/.test(trimmed)) {
      elements.push({ type: 'centered', text: trimmed.slice(1, -1).trim(), line: srcLine() });
      i++;
      continue;
    }

    // Scene heading: forced (.X) or known prefix, surrounded by blanks.
    const forcedScene = trimmed.startsWith('.') && !trimmed.startsWith('..');
    if ((forcedScene || SCENE_PREFIX.test(trimmed)) && isBlank(i - 1)) {
      let heading = forcedScene ? trimmed.slice(1).trim() : trimmed;
      let sceneNumber: string | undefined;
      const numMatch = /#([^#]+)#\s*$/.exec(heading);
      if (numMatch) {
        sceneNumber = (numMatch[1] ?? '').trim();
        heading = heading.replace(/#[^#]+#\s*$/, '').trim();
      }
      elements.push({ type: 'scene_heading', text: heading, sceneNumber, line: srcLine() });
      i++;
      continue;
    }

    // Transition: forced (>X) or UPPERCASE ending in 'TO:', surrounded by blanks.
    if (trimmed.startsWith('>') && !trimmed.endsWith('<')) {
      elements.push({ type: 'transition', text: trimmed.slice(1).trim(), line: srcLine() });
      i++;
      continue;
    }
    if (/[A-Z][A-Z ]*TO:$/.test(trimmed) && isBlank(i - 1) && isBlank(i + 1)) {
      elements.push({ type: 'transition', text: trimmed, line: srcLine() });
      i++;
      continue;
    }

    // Character cue: forced (@) or all-caps, preceded by blank, followed by non-blank.
    const forcedChar = trimmed.startsWith('@');
    const looksLikeCue =
      forcedChar ||
      (/^[A-Z0-9][A-Z0-9 .'`-]*(\([^)]*\))?\s*\^?$/.test(trimmed) &&
        /[A-Z]/.test(trimmed) &&
        trimmed === trimmed.toUpperCase());
    if (looksLikeCue && isBlank(i - 1) && !isBlank(i + 1)) {
      const dual = trimmed.endsWith('^');
      const name = (forcedChar ? trimmed.slice(1) : trimmed).replace(/\^$/, '').trim();
      elements.push({ type: 'character', name, dual, line: srcLine() });
      i++;
      // Consume the dialogue block: parentheticals + dialogue until a blank line.
      while (i < lines.length && (lines[i] ?? '').trim() !== '') {
        const { stripped: dlgStripped, notes: dlgNotes } = extractNotes(lines[i] ?? '');
        for (const n of dlgNotes) elements.push({ type: 'note', text: n, line: srcLine() });
        const d = dlgStripped.trim();
        if (d === '') {
          i++;
          continue;
        }
        if (/^\(.*\)$/.test(d)) {
          elements.push({ type: 'parenthetical', text: d.slice(1, -1).trim(), line: srcLine() });
        } else {
          elements.push({ type: 'dialogue', text: d, line: srcLine() });
        }
        i++;
      }
      continue;
    }

    // Forced action with '!'.
    if (line.startsWith('!')) {
      elements.push({ type: 'action', text: line.slice(1), line: srcLine() });
      i++;
      continue;
    }

    // Default: action.
    elements.push({ type: 'action', text: line, line: srcLine() });
    i++;
  }

  return { title, elements };
}
