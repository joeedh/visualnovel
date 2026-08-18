/**
 * What one agent turn may spend, and how a receipt is charged against it.
 *
 * Here rather than in `@vn/authoring` for the reason `textmodels.ts` is here: the loop that
 * enforces the ceiling, the REPL flag that sets it, the command that binds it and the renderer
 * menu that offers it all need the same answers, and only one of those may import a package that
 * loads a vendor SDK.
 */

/** The budget choices, in the order the menu offers them. `unlimited` removes the ceiling. */
export const BUDGET_CHOICES = [
  '50k',
  '100k',
  '200k',
  '400k',
  '600k',
  '1m',
  '5m',
  'unlimited',
] as const;

export type BudgetChoice = (typeof BUDGET_CHOICES)[number];

/**
 * Where every surface starts: enough to draft several scenes, small enough that a runaway costs
 * less than a coffee.
 */
export const DEFAULT_BUDGET: BudgetChoice = '200k';

/** The ceiling in tokens. `Infinity` for `unlimited`, which is the value the loop compares to. */
export function budgetTokens(choice: BudgetChoice): number {
  if (choice === 'unlimited') return Infinity;
  const n = Number(choice.slice(0, -1));
  return choice.endsWith('m') ? n * 1_000_000 : n * 1_000;
}

/** How a choice reads in a menu or a sentence. */
export function budgetLabel(choice: BudgetChoice): string {
  return choice;
}

/** The narrowest shape a receipt has to have to be charged. */
export interface Charged {
  input: number;
  output: number;
  /** Of `input`, what was billed at the cache-read rate. */
  cacheRead?: number;
}

/**
 * What one receipt spends against the budget: fresh input plus output, cache reads excluded.
 *
 * Three decisions in that. **Cache reads are free of the budget** — a long turn re-sends its
 * whole cached prefix on every step, so a total-input meter would kill a 40-step turn that had
 * added almost nothing. **Cache writes are counted**, being tokens the model had never seen,
 * sent for the first time and billed above the base rate. And **a provider that reports no split
 * spends its whole input**, because absent means the vendor said nothing, which for this purpose
 * is the same as no cache having been read.
 */
export function charge(u: Charged): number {
  return u.input - (u.cacheRead ?? 0) + u.output;
}
