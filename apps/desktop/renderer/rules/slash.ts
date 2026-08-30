/**
 * What `/` means in a composer: which skill the author is naming, which skills that narrows to,
 * and what the agent is actually sent once they press Enter.
 *
 * Pure, like `skills.ts` beside it, because the desktop jest project is node-only and a composer
 * can otherwise only be checked live over CDP. The menu, the caret and the key handling are the
 * pane's; every decision behind them is here.
 */
import type { SkillEntry } from '../../src/shared/ipc.js';

/** The characters a skill id is made of, which is therefore what a `/` token may contain. */
const TOKEN = /^\/[A-Za-z0-9._-]*/;

/**
 * The `/…` the caret is in, or `null`.
 *
 * Only at the very start of the box. A `/` anywhere else is punctuation — "and/or", a path, a
 * date — and a menu that opened over those would fight the author on every second sentence. The
 * caret has to be inside the token as well, so clicking away from a half-typed name closes the
 * menu rather than leaving it open over a word nobody is editing.
 */
export function slashQuery(text: string, caret: number): string | null {
  const token = TOKEN.exec(text);
  if (!token) return null;
  if (caret < 1 || caret > token[0].length) return null;
  return token[0].slice(1);
}

/**
 * The skills a query offers, best first: the ones whose id or name starts with it, then the ones
 * that merely contain it. An empty query offers everything, which is what bare `/` is for.
 *
 * Ranking rather than filtering to the prefix alone, because a skill an author half-remembers is
 * usually remembered by a word from the middle of its name.
 */
export function matchSkills(skills: readonly SkillEntry[], query: string): SkillEntry[] {
  const want = query.toLowerCase();
  if (!want) return [...skills];
  const starts: SkillEntry[] = [];
  const holds: SkillEntry[] = [];
  for (const skill of skills) {
    const id = skill.id.toLowerCase();
    const name = skill.name.toLowerCase();
    if (id.startsWith(want) || name.startsWith(want)) starts.push(skill);
    else if (id.includes(want) || name.includes(want)) holds.push(skill);
  }
  return [...starts, ...holds];
}

/** A composer's text and where the caret sits in it. */
export interface Composed {
  text: string;
  caret: number;
}

/**
 * The box once a skill is picked. The trailing space both ends the token — so the menu closes
 * rather than reopening on what was just completed — and puts the caret where the author types
 * what they want the skill applied to.
 */
export function completeSlash(text: string, skill: SkillEntry): Composed {
  const token = TOKEN.exec(text);
  const rest = token ? text.slice(token[0].length).replace(/^ +/, '') : text;
  const head = `/${skill.id} `;
  return { text: head + rest, caret: head.length };
}

/**
 * What a `/…` line is sent to the agent as. A leading token naming a skill this project has
 * becomes a sentence asking for that skill by name and path, with whatever followed it kept as
 * the request; everything else is sent exactly as typed.
 *
 * The agent is told rather than made to run anything: a skill is a playbook it reads and follows,
 * and one that carries a script is permissioned when the script runs. Naming the file as well as
 * the skill means it can read the playbook without guessing at `discover_skills` first.
 */
export function expandSlash(text: string, skills: readonly SkillEntry[]): string {
  const token = TOKEN.exec(text);
  if (!token) return text;
  const id = token[0].slice(1);
  const skill = skills.find((entry) => entry.id === id);
  if (!skill) return text;
  const rest = text.slice(token[0].length).trim();
  const head = `Follow the “${skill.name}” skill (${skill.file}).`;
  return rest ? `${head} ${rest}` : head;
}

/** Where a key moves the highlight in a list of `count` rows, wrapping at both ends. */
export function moveHighlight(at: number, count: number, by: number): number {
  if (count === 0) return 0;
  return (((at + by) % count) + count) % count;
}
