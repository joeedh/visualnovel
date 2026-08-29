/**
 * This proves that the agent's prompt prefix is actually being cached
 * (`docs/plans/archive/INDEX.md#prompt-caching-and-deferred-tool-loading` § Tests).
 *
 * A unit test can only check claims about the request itself, such as where the breakpoints are,
 * what defers, and what was echoed, and those are checked in
 * `packages/providers/src/backends/tests/`. A cache hit only exists in the vendor's reply, so
 * checking one takes a real key and a real bill. This script is that ritual, and it runs the one
 * the configured `models.text` calls for:
 *
 * - Claude: two steps of one conversation, asserting step 1 wrote a prefix and step 2 read it
 *   back. The breakpoints are ours to place, so the proof is that they were placed.
 * - Gemini: five calls carrying a byte-identical prefix, asserting that some call came back
 *   reporting a hit. There is nothing to place, because the implicit cache is opportunistic and
 *   says nothing at all on many calls that hit
 *   (`docs/plans/archive/INDEX.md#gemini-estimated-cache-hit-rate`), which is why five calls and not two.
 *
 * Usage:
 *   node scripts/verify-prompt-cache.mjs [dir]        # costs money; a handful of small calls
 *
 * This script is deliberately not in `package.json`'s scripts, and `pnpm test` will not run it,
 * exactly like its sibling `scripts/verify-prompt-chunks.mjs`. The key is resolved through
 * `resolveKeys` and never printed. That is the standing rule in `CLAUDE.md`, restated here because
 * a script that talks to a paid API is where it gets forgotten.
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
      "export { createAnthropicChat, createGeminiChat } from '@vn/providers';",
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
 * A prompt prefix long enough to be cacheable at all. Vendor minimums sit around 1–2k tokens, so
 * a short one would report nothing and look like a broken implementation rather than a request
 * that was simply too small — hence the padding, and hence step 1's own assertion below.
 *
 * `paras` is the dial because the minimums differ: Claude's breakpoints go on a catalog and a
 * system prompt that carry their own bulk, while the Gemini run below is this text and nothing
 * else, and has to clear 2k on its own.
 */
function fixedPrefix(paras) {
  const para =
    'You are a verification harness for the VN Generator authoring agent. You answer in one ' +
    'short sentence and you never call a tool. This paragraph exists to make the prompt prefix ' +
    'long enough to be cacheable at all, because a prefix under the vendor minimum is silently ' +
    'not cached and would be indistinguishable from a bug. It is fixed text: the same bytes on ' +
    'every run, which is the whole premise of a prefix cache.\n\n';
  return para.repeat(paras);
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
  `cache written ${usage.cacheWrite ?? '—'}${usage.cacheEstimated ? ' (estimated)' : ''}`;

/** Resolve the vendor's key, naming its *source* on failure — never its value. */
const keyFor = async (mod, config, vendor) =>
  (await mod.resolveKeys(config, { secretsDirs: await mod.secretDirsFor(dir), require: [vendor] }))[
    vendor
  ];

/** Two steps of one conversation: step 1 writes the prefix, step 2 reads it back. */
async function verifyClaude(mod, config, modelId) {
  const chat = mod.createAnthropicChat(await keyFor(mod, config, 'anthropic'), modelId);
  const backend = new mod.NativeAgentBackend(chat);
  const system = fixedPrefix(12);

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
}

/**
 * Sends five calls carrying one prefix. Gemini's implicit cache either matches the front of the
 * request or it does not, and there is nothing to place and nothing to echo, so the claim this
 * checks is only that it eventually reports a hit, and that what it reports arrives marked as the
 * estimate it is.
 *
 * Five calls are sent rather than two because the cache is slow to start and then intermittent.
 * Two runs on 2026-08-18 over a byte-identical 3.4k-token prefix: one reported nothing for calls
 * 1-2 and 88% of the input for 3-5; the other reported nothing at all except on call 4. So the
 * claim this can honestly make is that some call reports a hit, and a run that reports a hit on
 * none of five is the only failure. That intermittency is also why a conversation's running total
 * is an estimate rather than a bill.
 */
async function verifyGemini(mod, config, modelId) {
  const CALLS = 5;
  const chat = mod.createGeminiChat(await keyFor(mod, config, 'gemini'), modelId);
  // The fixed bytes lead the *prompt* rather than sitting in the system instruction, because what
  // is being tested is a prefix of the request and the numeral is the only thing that varies.
  const prefix = fixedPrefix(40);

  process.stdout.write(`model ${modelId} — ${CALLS} calls, all billed\n`);

  let firstHit = 0;
  let hits = 0;
  let hitUsage;
  for (let i = 1; i <= CALLS; i++) {
    const reply = await chat.messageWithUsage({
      system: 'You answer with one word and never explain.',
      prompt: `${prefix}Say the number ${i}.`,
    });
    const usage = reply.usage ?? {};
    process.stdout.write(`call ${i} · ${say(usage)}\n`);
    if ((usage.cacheRead ?? 0) > 0) {
      hits += 1;
      if (!firstHit) [firstHit, hitUsage] = [i, usage];
    }
  }

  const hit = ok(
    firstHit > 0,
    `no call in ${CALLS} reported a cached token. Either the prefix is under the vendor minimum ` +
      '(~1–2k tokens, higher for Pro), or something varies between the calls that should not — ' +
      'the implicit cache matches bytes, so a timestamp or a nonce anywhere in front defeats it.',
  );
  // Asserted on the call that hit, not the last one: a later call reporting nothing is the normal
  // behaviour above, and reading `cacheEstimated` off it would fail a working implementation.
  const marked =
    !hit ||
    ok(
      hitUsage.cacheEstimated === true,
      'a cached count came back unmarked — `usageOf` reported a split without `cacheEstimated`, ' +
        'so the tooltip will present a matched prefix as though it were a bill.',
    );

  if (hit && marked) {
    const share = Math.round(((hitUsage.cacheRead ?? 0) / (hitUsage.input || 1)) * 100);
    process.stdout.write(
      `PASS — ${hits} of ${CALLS} calls reported a cache read, first on call ${firstHit}, ` +
        `${share}% of its input.\n`,
    );
  }
}

try {
  const mod = createRequire(import.meta.url)(TMP);
  const config = await mod.loadConfig(dir);
  const modelId = config.models.text;

  if (/^(claude|anthropic)/i.test(modelId)) await verifyClaude(mod, config, modelId);
  else if (/^(gemini|google)/i.test(modelId)) await verifyGemini(mod, config, modelId);
  else {
    process.stdout.write(
      `SKIP — ${dir} is configured for "${modelId}", which this script knows no cache ritual ` +
        'for. Point it at a project whose `models.text` is a Claude or Gemini model.\n',
    );
    // Not `process.exit`, which would skip the cleanup below and leave the bundle in the tree.
    throw new Skip();
  }
} catch (err) {
  if (!(err instanceof Skip)) throw err;
} finally {
  await fs.rm(TMP, { force: true });
  await fs.rm(`${TMP}.map`, { force: true });
}
