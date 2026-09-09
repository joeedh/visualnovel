/** Parses the app's own argv, and the env-var fallbacks that stand in for it. */
import { app } from 'electron';

/** `--mock` / `--project <dir>` (also `--project=<dir>`) / `--smoke`, from the app's own argv. */
export interface CliArgs {
  mock: boolean;
  project?: string;
  /** Resolve the two external SDKs, say so, and exit. See `./smoke.ts`. */
  smoke: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let mock = false;
  let project: string | undefined;
  let smoke = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--mock') mock = true;
    else if (arg === '--smoke') smoke = true;
    else if (arg === '--project') project = argv[++i];
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length);
  }
  return { mock, project, smoke };
}

// Electron's own argv carries an extra `appPath` ('.') entry when running unpackaged
// (`electron .`) that a packaged executable's argv does not.
export const cliArgs = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2));

export const MOCK = cliArgs.mock || process.env.VN_MOCK === '1';
