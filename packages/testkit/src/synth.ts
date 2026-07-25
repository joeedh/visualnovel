import { makeProject, TestProject } from './project.js';

export interface SynthOptions {
  /** Number of scenes in the generated script. Default 12. */
  scenes?: number;
  /** Branch factor: >1 emits choices, 1 emits a linear `[[next:]]` chain. Default 2. */
  fanout?: number;
  /** Size of the speaking cast, cycled scene by scene. Default 2. */
  characters?: number;
  /** Number of distinct locations, cycled scene by scene. Default 3. */
  locations?: number;
  title?: string;
  git?: boolean;
}

const CAST = ['AIKO', 'HARUKI', 'MEI', 'REN', 'SORA', 'TAMA', 'YUKI', 'KOZUE'];
const PLACES = ['CLASSROOM', 'ROOFTOP', 'HALL', 'LIBRARY', 'COURTYARD', 'STAIRWELL'];
const SUFFIXES = 'BCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The `i`th name from a roster, extending it with a letter suffix once it wraps
 * (`AIKO`, …, `KOZUE`, `AIKO B`, …). Letters only: digits would still parse as a cue, but
 * these names also become slugged ids and reading `aiko_b` beats reading `char_9`.
 */
function nameAt(roster: string[], i: number): string {
  const base = roster[i % roster.length]!;
  const round = Math.floor(i / roster.length);
  if (round === 0) return base;
  const suffix = SUFFIXES[round - 1];
  if (!suffix) throw new Error(`synth roster exhausted at index ${i}`);
  return `${base} ${suffix}`;
}

/** Children of scene `i` in a `fanout`-ary tree over `total` scenes, clipped to the last one. */
function childrenOf(i: number, fanout: number, total: number): number[] {
  const out: number[] = [];
  for (let k = 1; k <= fanout; k++) {
    const child = i * fanout + k;
    if (child < total) out.push(child);
  }
  return out;
}

/**
 * Generate a screenplay of `scenes` scenes as a `fanout`-ary tree rooted at `s0`, so every
 * scene is reachable and no `goto` dangles. Purely a function of its options — task identity
 * is `sha256(kind, inputs)`, so any randomness here would produce a different task set on
 * every run and make scale checks unreproducible.
 */
export function synthScript(opts: SynthOptions = {}): string {
  const scenes = opts.scenes ?? 12;
  const fanout = opts.fanout ?? 2;
  const cast = opts.characters ?? 2;
  const places = opts.locations ?? 3;
  if (scenes < 1) throw new Error('synth needs at least one scene');
  if (fanout < 1) throw new Error('synth needs a fanout of at least 1');
  if (cast < 1 || places < 1) throw new Error('synth needs at least one character and location');

  const lines: string[] = [];
  for (let i = 0; i < scenes; i++) {
    const place = nameAt(PLACES, i % places);
    lines.push(
      `INT. ${place} - DAY`,
      '',
      `[[scene: s${i}]]`,
      '',
      `Scene ${i} opens on the ${place.toLowerCase()}.`,
      '',
      nameAt(CAST, i % cast),
      `Line ${i}.`,
      '',
    );
    const children = childrenOf(i, fanout, scenes);
    if (children.length > 1) {
      for (const child of children) lines.push(`[[choice: To scene ${child} -> s${child}]]`);
      lines.push('');
    } else if (children.length === 1) {
      lines.push(`[[next: s${children[0]}]]`, '');
    }
  }
  return lines.join('\n');
}

/**
 * A synthetic project at scale, for measuring how a view behaves on a large graph.
 *
 * Scenes are not nodes: a fully-run project settles at `L + 4C + 2N` tasks for `N` scenes,
 * `C` characters and `L` locations (`4C` = one portrait plus three model-sheet angles; `2N`
 * = one establishing shot plus one per speaking character). Assert on `graph.all().length`.
 * Reaching that total needs a real `run()` — a dry run stops after one planning pass, and
 * shot tasks only appear once their location plates are `done`.
 */
export function synthProject(opts: SynthOptions = {}): Promise<TestProject> {
  return makeProject({
    title: opts.title ?? `Synth ${opts.scenes ?? 12}`,
    script: synthScript(opts),
    git: opts.git,
  });
}
