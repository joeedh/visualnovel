/**
 * Per-worker jest setup. One job: point `$VNAUTHOR_HOME` at a directory that does not exist.
 *
 * `secretDirsFor` consults the user's own `keys/` by default, so that every host gets the last
 * rung of key resolution without a change and none can forget it. The cost is that a test which
 * resolves keys would otherwise read the *developer's* key off their own machine — passing for
 * the wrong reason there and failing on CI, where there is none. `@vn/testkit` opts out
 * explicitly; this is the guard for everything that forgets.
 *
 * The path is per-worker and never created, so `userConfigDir()` answers with somewhere empty
 * rather than somewhere shared. An override also suppresses the `~/.vnauthor` fallback, which is
 * what keeps a developer's legacy directory out of the run too.
 */
const { join } = require('node:path');
const { tmpdir } = require('node:os');

process.env.VNAUTHOR_HOME = join(
  tmpdir(),
  `vn-jest-userhome-${process.env.JEST_WORKER_ID ?? '0'}-${process.pid}`,
);
