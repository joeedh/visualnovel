/** `vnauthor` entry: parse argv and start the REPL (plan §M4). */
import { runRepl } from './repl.js';

/** Route `vnauthor [dir] [--mock]` to the interactive loop. */
export async function main(argv: string[]): Promise<number> {
  const positional: string[] = [];
  let mock = false;
  let native = false;
  for (const arg of argv) {
    if (arg === '--mock') mock = true;
    else if (arg === '--native') native = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      return 0;
    } else if (!arg.startsWith('-')) positional.push(arg);
  }
  const dir = positional[0] ?? '.';
  return runRepl({ dir, mock, native, secretsDir: `${dir}/keys` });
}

function usage(): string {
  return [
    'vnauthor — interactive authoring agent for VN Generator inputs',
    '',
    'Usage: vnauthor [dir] [--mock] [--native]',
    '',
    '  dir        project directory (default: .)',
    '  --mock     run offline with no model (read-only smoke test)',
    '  --native   use provider-native function-calling when supported',
    '',
  ].join('\n');
}

export { runRepl } from './repl.js';
export { createAuthoringAgent } from './agent.js';
