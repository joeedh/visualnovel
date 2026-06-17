import { createLogger } from '@vn/util';
import { cmdApprove, cmdCost, cmdGraph, cmdRun, cmdStatus, parseArgs } from './commands.js';

/** Entry point: route `vngen <command>` to its handler (report §10). */
export async function main(argv: string[]): Promise<number> {
  const logger = createLogger();
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return 0;
  }
  const args = parseArgs(rest);
  try {
    switch (command) {
      case 'run':
        return await cmdRun(args, logger);
      case 'approve':
        return await cmdApprove(args);
      case 'status':
        return await cmdStatus(args);
      case 'graph':
        return await cmdGraph(args);
      case 'cost':
        return await cmdCost(args, logger);
      default:
        process.stdout.write(`vngen: unknown command "${command}"\n\n${usage()}`);
        return 1;
    }
  } catch (err) {
    logger.error('vngen.failed', {
      command,
      error: err instanceof Error ? err.message : String(err),
    });
    process.stderr.write(`vngen: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function usage(): string {
  return [
    'vngen — visual novel generator',
    '',
    'Usage: vngen <command> [dir] [options]',
    '',
    'Commands:',
    '  run [dir] [--mock]   parse → validate → preview → execute to the next gate',
    '  approve [dir] [--character=<id>] [--hash=<h>] [--yes]   approve portraits (interactive)',
    '  status [dir]         show task/asset/approval status',
    '  graph [dir]          emit the story branch graph (Mermaid)',
    '  cost [dir]           dry-run cost preview',
    '',
  ].join('\n');
}
