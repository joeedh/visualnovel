/** `vnauthor` entry: parse argv and start the REPL (plan §M4). */
import { runRepl } from './repl.js';

/** Route `vnauthor [dir] [--mock]` to the interactive loop. */
export async function main(argv: string[]): Promise<number> {
  const positional: string[] = [];
  let mock = false;
  let noNative = false;
  for (const arg of argv) {
    if (arg === '--mock') mock = true;
    else if (arg === '--no-native') noNative = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      return 0;
    } else if (!arg.startsWith('-')) positional.push(arg);
  }
  const dir = positional[0] ?? '.';
  return runRepl({ dir, mock, noNative });
}

function usage(): string {
  return [
    'vnauthor — interactive authoring agent for VN Generator inputs',
    '',
    'Usage: vnauthor [dir] [--mock] [--no-native]',
    '',
    '  dir           project directory (default: .)',
    '  --mock        run offline with no model (read-only smoke test)',
    '  --no-native   force the text tool protocol even where the model can call tools',
    '                natively; the native path is the default and the cached one',
    '',
  ].join('\n');
}

export { runRepl } from './repl.js';
export { createAuthoringAgent } from './agent.js';
