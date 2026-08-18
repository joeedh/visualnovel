/**
 * Terminal rendering for the REPL (plan §9): plans, agent events, and unified diffs. Kept
 * dependency-free — ANSI codes are inlined and degrade to plain text when colour is off
 * (e.g. piped output). No business logic lives here; it only formats what the loop emits.
 */
import type { AgentEvent, Plan, PlanDecision } from '@vn/authoring';

const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];
const wrap = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = (s: string): string => wrap('2', s);
export const bold = (s: string): string => wrap('1', s);
export const green = (s: string): string => wrap('32', s);
export const red = (s: string): string => wrap('31', s);
export const yellow = (s: string): string => wrap('33', s);
export const cyan = (s: string): string => wrap('36', s);

/** Render a proposed plan as an approval card. */
export function renderPlan(plan: Plan): string {
  const lines = [bold('Proposed plan'), `  ${plan.summary}`];
  if (plan.steps.length) {
    lines.push('', dim('  Steps:'));
    plan.steps.forEach((s, i) => lines.push(`    ${i + 1}. ${s}`));
  }
  if (plan.files.length) {
    lines.push('', dim('  Files:'));
    plan.files.forEach((f) => lines.push(`    ${cyan(f)}`));
  }
  if (plan.risks?.length) {
    lines.push('', yellow('  Risks:'));
    plan.risks.forEach((r) => lines.push(`    ${yellow('!')} ${r}`));
  }
  return lines.join('\n');
}

/** Colourize a unified diff (git diff / git show output) line-by-line. */
export function renderDiff(diff: string): string {
  if (!diff.trim()) return dim('(no changes)');
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) return green(line);
      if (line.startsWith('-') && !line.startsWith('---')) return red(line);
      if (line.startsWith('@@')) return cyan(line);
      if (/^(diff |index |--- |\+\+\+ )/.test(line)) return dim(line);
      return line;
    })
    .join('\n');
}

/** Format a single streamed agent event for the terminal. */
export function renderEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'message':
      return event.text.trim() ? dim(`  · ${event.text.trim()}`) : undefined;
    case 'tool': {
      const mark = event.result.ok ? green('✓') : red('✗');
      const wrote = event.result.written?.length
        ? dim(` → ${event.result.written.join(', ')}`)
        : '';
      return `  ${mark} ${bold(event.tool)}${wrote}`;
    }
    case 'plan':
      return renderDecision(event.decision);
    case 'mode':
      return dim(`  → switched to ${event.mode} mode`);
    case 'blocked':
      return yellow(`  ⊘ ${event.tool} blocked: ${event.reason}`);
    case 'usage':
      return undefined; // a receipt is not narration — the REPL prints the running total
    case 'final':
      return undefined; // printed by the REPL as the assistant's reply
  }
}

/**
 * The running total, printed under a reply. It counts calls rather than turns — a step the model
 * had to be asked twice for was billed twice — and says nothing at all until a provider reports
 * something, because a mock backend and a backend that does not say are both zero.
 */
export function renderTokens(input: number, output: number): string | undefined {
  const total = input + output;
  if (total === 0) return undefined;
  const short =
    total < 1000
      ? String(total)
      : total < 1_000_000
        ? `${(total / 1000).toFixed(1)}k`
        : `${(total / 1_000_000).toFixed(2)}M`;
  return dim(`  ${short} tokens this session (${input} in, ${output} out)`);
}

function renderDecision(decision: PlanDecision): string {
  return decision.approved
    ? green('  ✓ plan approved')
    : yellow(`  ⊘ plan rejected${decision.feedback ? `: ${decision.feedback}` : ''}`);
}
