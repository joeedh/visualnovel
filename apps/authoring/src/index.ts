/** `vnauthor` entry: parse argv and start the REPL (plan §M4). */
import { BUDGET_CHOICES, type BudgetChoice } from './agent.js';
import { runRepl } from './repl.js';

/** Route `vnauthor [dir] [--mock]` to the interactive loop. */
export async function main(argv: string[]): Promise<number> {
  const positional: string[] = [];
  let mock = false;
  let noNative = false;
  let budget: BudgetChoice | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--mock') mock = true;
    else if (arg === '--no-native') noNative = true;
    else if (arg === '--budget' || arg.startsWith('--budget=')) {
      const value = arg.startsWith('--budget=') ? arg.slice('--budget='.length) : argv[++i];
      if (!value || !BUDGET_CHOICES.includes(value as BudgetChoice)) {
        process.stderr.write(
          `--budget takes one of: ${BUDGET_CHOICES.join(', ')}` +
            (value ? ` (got "${value}")` : '') +
            '\n',
        );
        return 2;
      }
      budget = value as BudgetChoice;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      return 0;
    } else if (!arg.startsWith('-')) positional.push(arg);
  }
  const dir = positional[0] ?? '.';
  return runRepl({ dir, mock, noNative, ...(budget ? { budget } : {}) });
}

function usage(): string {
  return [
    'vnauthor — interactive authoring agent for VN Generator inputs',
    '',
    'Usage: vnauthor [dir] [--mock] [--no-native] [--budget <size>]',
    '',
    '  dir           project directory (default: .)',
    '  --mock        run offline with no model (read-only smoke test)',
    '  --no-native   force the text tool protocol even where the model can call tools',
    '                natively; the native path is the default and the cached one',
    `  --budget      what one turn may spend, in non-cached tokens: ${BUDGET_CHOICES.join(', ')}`,
    '                (default: 200k; /budget changes it mid-session)',
    '',
  ].join('\n');
}

export { runRepl } from './repl.js';
export { createAuthoringAgent } from './agent.js';
