import type { Defect } from '@vn/types';

/**
 * P6/P7 prompt refinement (report §P6, §P7). Given the prompt that produced a flawed image
 * and the structured defects the reviewers found, produce a corrected prompt. This is
 * deterministic — it folds each defect's suggested fix (or its description) into an explicit
 * "Corrections" clause — so the refine step is reproducible and costs no extra LLM call.
 */
export function refinePrompt(basePrompt: string, defects: Defect[]): string {
  if (defects.length === 0) return basePrompt;
  const corrections = defects.map((d) =>
    (d.suggestedFix ?? `fix ${d.category}: ${d.description}`).trim(),
  );
  // Strip any prior corrections clause so repeated refines don't accumulate stale fixes.
  const base = basePrompt.replace(/\s*Corrections:.*$/s, '').trim();
  return `${base} Corrections: ${corrections.join('; ')}.`;
}
