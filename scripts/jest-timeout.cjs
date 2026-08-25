/**
 * Raises the per-test timeout above jest's 5 s default, for every project.
 *
 * A test that builds a project on disk spawns `git` several times, and process creation on Windows
 * costs enough that a full parallel run tips such a test over the default while the same test
 * passes on its own. A suite needing longer still calls `jest.setTimeout` itself, which runs after
 * this and wins.
 *
 * This is a `setupFilesAfterEnv` entry rather than a `testTimeout` key because jest 29 rejects that
 * key inside a project config.
 */
jest.setTimeout(30_000);
