/**
 * A situation: one named fixture of a rule module's state type, and the one hand-written input to
 * the derived UX model (`docs/reference/guided-tours.md`, Part III). The driver in
 * `rules/model.ts` runs each module's `controls` over its list and records what came back.
 */
export interface Situation<S> {
  name: string;
  /** One sentence on what this state gates: which control it lists, refuses, or offers differently. */
  why: string;
  state: S;
}

/** Builds a list, refusing a repeated name so a copied fixture cannot shadow another's records. */
export function situations<S>(...list: Situation<S>[]): readonly Situation<S>[] {
  const seen = new Set<string>();
  for (const { name } of list) {
    if (seen.has(name)) throw new Error(`two situations are named ${name}`);
    seen.add(name);
  }
  return list;
}
