/**
 * Prove that the agent's prompt prefix is actually being cached
 * (`docs/plans/prompt-caching-and-deferred-tool-loading.md` § Tests).
 *
 * Everything about caching that a unit test can check is a claim about the *request* — where the
 * breakpoints are, what defers, what was echoed — and those are checked in
 * `packages/providers/src/backends/tests/`. A cache **hit** only exists in the vendor's reply, so
 * it takes a real key and a real bill. This is that ritual: two steps of one conversation against
 * the configured Claude model, asserting step 1 wrote a prefix and step 2 read it back.
 *
 * Usage:
 *   node scripts/verify-prompt-cache.mjs [dir]        # costs money; two small calls
 *
 * It is deliberately **not** in `package.json`'s scripts and `pnpm test` will not run it, exactly
 * like its sibling `scripts/verify-prompt-chunks.mjs`. The key is resolved through `resolveKeys`
 * and never printed — the standing rule in `CLAUDE.md`, restated here because a script that talks
 * to a paid API is where it gets forgotten.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';

const dir = resolve(process.argv[2] ?? '.');
const TMP = resolve(root, 'packages/providers/.cache-entry.cjs');

// Bundled into `packages/providers` because the model SDKs are `EXTERNAL` and lazy-imported, and
// `@anthropic-ai/sdk` is a dependency of that package alone.
await build({
  stdin: {
    contents: [
      "export { loadConfig, resolveKeys, secretDirsFor } from '@vn/config';",
      "export { createAnthropicChat } from '@vn/providers';",
      "export { NativeAgentBackend } from '@vn/authoring';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  outfile: TMP,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias,
  external: EXTERNAL,
  logLevel: 'warning',
});

/** Roughly what the agent advertises: a handful always loaded, the rest deferred. */
const TOOLS = [
  { name: 'read_file', description: 'Read a file in the project.', parameters: PARAMS() },
  { name: 'search', description: 'Search the project for a string.', parameters: PARAMS() },
  { name: 'list_workspace', description: 'List what the project contains.', parameters: PARAMS() },
  { name: 'write_file', description: 'Write a file.', parameters: PARAMS(), defer: true },
  {
    name: 'apply_edit',
    description: 'Apply an edit to a scene.',
    parameters: PARAMS(),
    defer: true,
  },
  { name: 'commit', description: 'Commit the working tree.', parameters: PARAMS(), defer: true },
];

function PARAMS() {
  return { type: 'object', additionalProperties: true };
}

/**
 * A system prompt long enough to be cacheable at all. The minimum cacheable prefix is ~1024
 * tokens, so a short one would report no cache write and look like a broken implementation
 * rather than a request that was simply too small — hence the padding, and hence step 1's own
 * assertion below.
 */
function systemPrompt() {
  const para =
    'You are a verification harness for the VN Generator authoring agent. You answer in one ' +
    'short sentence and you never call a tool. This paragraph exists to make the prompt prefix ' +
    'long enough to be cacheable at all, because a prefix under the vendor minimum is silently ' +
    'not cached and would be indistinguishable from a bug. It is fixed text: the same bytes on ' +
    'every run, which is the whole premise of a prefix cache.\n\n';
  return para.repeat(12);
}

/** The one non-failure way out of the run below, so the `finally` still tidies up. */
class Skip extends Error {}

const ok = (claim, message) => {
  if (!claim) {
    process.stdout.write(`FAIL — ${message}\n`);
    process.exitCode = 1;
    return false;
  }
  return true;
};

const say = (usage) =>
  `input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead ?? '—'}, ` +
  `cache written ${usage.cacheWrite ?? '—'}`;

try {
  const mod = createRequire(import.meta.url)(TMP);
  const config = await mod.loadConfig(dir);
  const modelId = config.models.text;
  if (!/^(claude|anthropic)/i.test(modelId)) {
    process.stdout.write(
      `SKIP — ${dir} is configured for "${modelId}", and only Claude models cache. ` +
        'Point this at a project whose `models.text` is a Claude model.\n',
    );
    // Not `process.exit`, which would skip the cleanup below and leave the bundle in the tree.
    throw new Skip();
  }

  // Through `resolveKeys` so a missing key names its *source* — never its value, which is not
  // printed here or anywhere below.
  const keys = await mod.resolveKeys(config, {
    secretsDirs: await mod.secretDirsFor(dir),
    require: ['anthropic'],
  });
  const chat = mod.createAnthropicChat(keys.anthropic, modelId);
  const backend = new mod.NativeAgentBackend(chat);
  const system = systemPrompt();

  process.stdout.write(`model ${modelId} — two calls, both billed\n`);

  const messages = [{ role: 'user', content: 'Say "one".' }];
  const first = await backend.next(system, messages, TOOLS);
  process.stdout.write(`step 1 · ${say(first.usage ?? {})}\n`);

  const wrote =
    ok(first.usage, 'step 1 reported no usage at all — the backend kept no receipt') &&
    ok(
      (first.usage?.cacheWrite ?? 0) > 0,
      'step 1 wrote nothing to the cache. Either the breakpoints are not being placed, or the ' +
        'prefix is under the vendor minimum (~1024 tokens) — check the tool catalog and system ' +
        'prompt sizes before blaming the markers.',
    );

  // The conversation as the loop would carry it: the assistant's blocks echoed verbatim, then the
  // next thing the author said. Everything before that echo is the prefix step 2 should read.
  messages.push({ role: 'assistant', content: first.raw ?? [] });
  messages.push({ role: 'user', content: 'Say "two".' });
  const second = await backend.next(system, messages, TOOLS);
  process.stdout.write(`step 2 · ${say(second.usage ?? {})}\n`);

  const read = ok(
    (second.usage?.cacheRead ?? 0) > 0,
    'step 2 read nothing from the cache — the prefix changed between the two steps.',
  );

  if (wrote && read) {
    const share = Math.round(((second.usage.cacheRead ?? 0) / (second.usage.input || 1)) * 100);
    process.stdout.write(`PASS — step 2 read ${share}% of its input from the cache.\n`);
  }
} catch (err) {
  if (!(err instanceof Skip)) throw err;
} finally {
  await fs.rm(TMP, { force: true });
  await fs.rm(`${TMP}.map`, { force: true });
}
