/**
 * Replacing everything personal, on the boundary rather than in a prompt.
 *
 * Nothing reaches the debug agent unredacted — not the transcript, not the author's note, not a
 * tool result. Asking a model to anonymise usually works and occasionally does not, and
 * "occasionally" here means a character name in a public issue. The prompt still asks for general
 * terms, as a second layer; this is the mechanism.
 *
 * The pseudonym map is held in memory for the life of one report and never written down: it is
 * not sent to the model, not saved beside the report, and not in the issue. A report is not
 * de-anonymisable by whoever reads it.
 */

import type { ProjectModel } from '@vn/types';

/** Something the fiction names, and the series its pseudonym is drawn from. */
export interface NamedEntity {
  /** What markers, cast lists and shots point at — `titus`, `cafe-mori`. */
  id: string;
  /** What a reader sees, when the sheet gives one — `Titus Vale`. */
  name?: string;
  kind: 'character' | 'location' | 'item' | 'scene';
}

/** What the machine gives away, which the loaded project knows nothing about. */
export interface MachineFacts {
  /** The absolute project root. It and everything under it become `<project>/…`. */
  projectRoot?: string;
  /** The account name the app is running as. */
  username?: string;
  /** The home directory, so a path outside the project still says nothing about who owns it. */
  homeDir?: string;
}

export interface RedactionSources extends MachineFacts {
  entities: NamedEntity[];
  /** The project's own title, from `project.yaml`. */
  projectTitle?: string;
}

/**
 * Everything a loaded project names, in the shape the redactor wants. Pure, so the caller keeps
 * the `os` calls: main supplies `userInfo().username` and `homedir()`, and a test supplies
 * whatever it likes.
 *
 * Scenes contribute their id alone — a scene has no title, and its synopsis is prose whose names
 * the entity pass replaces anyway.
 */
export function sourcesFrom(model: ProjectModel, machine: MachineFacts = {}): RedactionSources {
  const entities: NamedEntity[] = [];
  for (const character of model.characters.values()) {
    entities.push({ id: character.id, name: character.name, kind: 'character' });
  }
  for (const location of model.locations.values()) {
    entities.push({ id: location.id, name: location.name, kind: 'location' });
  }
  for (const id of model.scenes.keys()) entities.push({ id, kind: 'scene' });
  return { entities, projectTitle: model.title, ...machine };
}

export interface Redactor {
  /** Replace every known name. Stable across calls for the life of one redactor. */
  apply(text: string): string;
  /** Names still present — the leak scan, run over the finished report. */
  leaks(text: string): string[];
}

const PROJECT = '<project>';
const AUTHOR = '<author>';

/**
 * An alias shorter than this is not replaced. Ids are slugs, and a one-character one would turn
 * every `a` in the transcript into a pseudonym — which destroys the evidence to protect a name
 * that was never identifying.
 */
const MIN_ALIAS = 2;

/** The exception: one character of a script written without spaces is a whole name, not a letter. */
function longEnough(alias: string): boolean {
  const chars = [...alias];
  return chars.length >= MIN_ALIAS || (chars.length === 1 && UNSPACED.test(chars[0]!));
}

const SERIES: Record<NamedEntity['kind'], { label: string; numeric: boolean }> = {
  character: { label: 'Character', numeric: false },
  location: { label: 'Location', numeric: false },
  item: { label: 'Item', numeric: false },
  scene: { label: 'Scene', numeric: true },
};

/** `0 → A`, `25 → Z`, `26 → AA`. Bijective base 26, so no index is spelled two ways. */
function letters(index: number): string {
  let out = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    out = String.fromCharCode(65 + (n % 26)) + out;
  }
  return out;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORDISH = /[\p{L}\p{N}_]/u;
const GUARD = '[\\p{L}\\p{N}_]';

/**
 * Scripts written without spaces. A boundary guard is what stops `Mori` matching inside
 * `Morison`, and there is no such thing to guard against in Japanese — requiring one there would
 * silently refuse to redact every name in a Japanese project, which is the failure that matters.
 */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

function guarded(alias: string): string {
  const chars = [...alias];
  const edge = (char: string | undefined) =>
    char !== undefined && WORDISH.test(char) && !UNSPACED.test(char);
  const left = edge(chars[0]) ? `(?<!${GUARD})` : '';
  const right = edge(chars[chars.length - 1]) ? `(?!${GUARD})` : '';
  return `${left}${escapeRe(alias)}${right}`;
}

/**
 * A path as it might be written anywhere: either separator, doubled by JSON escaping, in any
 * case. Tool args reach the report having been through `JSON.stringify`, so `C:\dev\x` arrives as
 * `C:\\dev\\x` — one pattern has to see both.
 */
function pathPattern(root: string): RegExp {
  const parts = root
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(escapeRe);
  const lead = /^[\\/]/.test(root) ? '[\\\\/]+' : '';
  return new RegExp(`${lead}${parts.join('[\\\\/]+')}(?!${GUARD})`, 'giu');
}

interface Alias {
  /** The text as the sources gave it, which is what a leak report names. */
  source: string;
  /** The entity it belongs to — an id and a display name share one. */
  key: string;
  kind?: NamedEntity['kind'];
  /** A fixed replacement, for the project title and the account name. */
  fixed?: string;
}

/**
 * The redactor for one report.
 *
 * Pseudonyms are assigned on **first appearance in the text**, not in source order, so `Character
 * A` is the first character the conversation mentions — which is what makes a redacted transcript
 * readable rather than a lookup exercise.
 */
export function buildRedactor(sources: RedactionSources): Redactor {
  const aliases: Alias[] = [];
  const add = (source: string | undefined, rest: Omit<Alias, 'source'>) => {
    const trimmed = source?.trim();
    if (trimmed && longEnough(trimmed)) aliases.push({ source: trimmed, ...rest });
  };

  for (const entity of sources.entities) {
    const key = `${entity.kind}:${entity.id}`;
    add(entity.id, { key, kind: entity.kind });
    add(entity.name, { key, kind: entity.kind });
  }
  add(sources.projectTitle, { key: 'project', fixed: PROJECT });
  add(sources.username, { key: 'author', fixed: AUTHOR });

  // Longest first, because JS alternation takes the leftmost alternative that matches rather than
  // the longest — without this, `Titus Vale` is half-replaced by `Titus`.
  const ordered = [...aliases].sort((a, b) => b.source.length - a.source.length);
  const byAlias = new Map(ordered.map((alias) => [alias.source.toLowerCase(), alias]));
  const matcher =
    ordered.length === 0
      ? undefined
      : new RegExp(ordered.map((alias) => guarded(alias.source)).join('|'), 'giu');

  // The project root is replaced before the home directory: a project inside the author's home
  // would otherwise come out as `<author>/dev/proj`, naming the layout instead of hiding it.
  const paths: { pattern: RegExp; with: string; source: string }[] = [];
  if (sources.projectRoot) {
    paths.push({
      pattern: pathPattern(sources.projectRoot),
      with: PROJECT,
      source: sources.projectRoot,
    });
  }
  if (sources.homeDir) {
    paths.push({ pattern: pathPattern(sources.homeDir), with: AUTHOR, source: sources.homeDir });
  }

  const assigned = new Map<string, string>();
  const counts = new Map<NamedEntity['kind'], number>();

  function pseudonym(alias: Alias): string {
    if (alias.fixed) return alias.fixed;
    const held = assigned.get(alias.key);
    if (held) return held;

    const kind = alias.kind ?? 'item';
    const index = counts.get(kind) ?? 0;
    counts.set(kind, index + 1);
    const { label, numeric } = SERIES[kind];
    const name = `${label} ${numeric ? index + 1 : letters(index)}`;
    assigned.set(alias.key, name);
    return name;
  }

  function apply(text: string): string {
    let out = text;
    for (const path of paths) out = out.replace(path.pattern, path.with);
    if (!matcher) return out;
    return out.replace(matcher, (match) => {
      const alias = byAlias.get(match.toLowerCase());
      return alias ? pseudonym(alias) : match;
    });
  }

  function leaks(text: string): string[] {
    const found: string[] = [];
    const seen = new Set<string>();
    const note = (source: string) => {
      if (seen.has(source)) return;
      seen.add(source);
      found.push(source);
    };

    for (const path of paths) {
      if (new RegExp(path.pattern.source, 'iu').test(text)) note(path.source);
    }
    if (matcher) {
      for (const match of text.matchAll(new RegExp(matcher.source, 'giu'))) {
        const alias = byAlias.get(match[0].toLowerCase());
        if (alias) note(alias.source);
      }
    }
    return found;
  }

  return { apply, leaks };
}
