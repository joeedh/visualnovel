/** Executable entry: the esbuild bundle target. Delegates to `main`. */
import { main } from './index.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(String(err instanceof Error ? (err.stack ?? err.message) : err) + '\n');
    process.exit(1);
  },
);
