/**
 * A local stand-in for `api.anthropic.com`, so the whole diagnose-an-API-error path can be walked
 * without a key, a bill, or a real 400 to wait for
 * (`docs/plans/archive/INDEX.md#diagnosing-an-api-error-from-the-request-that-caused-it` § Testing).
 *
 * It speaks just enough of `POST /v1/messages` to answer from a script and to fail on cue with a
 * **real** positional refusal:
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":
 *        "messages.1.content.0: unexpected `tool_use_id` found in `tool_search_tool_result` blocks"}}
 *
 * A *server* rather than a stub `ChatBackend`, deliberately. What is under test is the real SDK's
 * error object, the real `captureRequest` around the real call, and `faultKind` reading a real
 * status out of a real `cause` chain. A stub class would be a test of our own mock.
 *
 * The SDK reads `ANTHROPIC_BASE_URL` on its own, so nothing in `packages/providers` learns a test
 * exists. This is **not** `--mock`: `--mock` makes no calls at all, and `previewReport` refuses to
 * analyse under it. This is a real binding pointed elsewhere, which is why the caller still needs
 * `ANTHROPIC_API_KEY` set to something — anything; nothing here checks it, and nothing here logs
 * it either.
 *
 * Usage:
 *   node scripts/fake-anthropic.mjs [--port 8788] [--fail-after 1] [--always-fail]
 *
 *   --fail-after N   answer N agent calls, then refuse every agent call after them (default 1);
 *                    analyst calls are answered from their own script whatever this says
 *   --always-fail    refuse from the first call
 *   --port           default 8788; 0 asks the OS and the chosen one is printed
 *
 * It prints one line per call — method, path, byte count, and what it answered — and nothing of
 * the body, because the body is the author's conversation.
 *
 * As a module it exports {@link startFakeAnthropic}, which is how `verify-agent-report.mjs` runs
 * one in-process and reads back what it saw.
 */
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';

/** The refusal. Copied from a real one: positional, and unreadable without the body it names. */
export const POSITIONAL_REFUSAL =
  'messages.1.content.0: unexpected `tool_use_id` found in `tool_search_tool_result` blocks';

/** What a scripted success says, when the walkthrough has not supplied its own. */
const DEFAULT_REPLY = 'Right — I have read the scene and it looks consistent.';

/**
 * Which caller this is.
 *
 * `ANTHROPIC_BASE_URL` is process-wide, so the debug analyst comes here too — and answering *it*
 * with the positional refusal would fail the very step the walkthrough exists to watch. They are
 * told apart by the analyst's own tool: only its prompt advertises `submit_report`, because only
 * it is given that tool. Crude, and exactly as crude as it needs to be for a script that never
 * leaves loopback.
 */
function isAnalyst(raw) {
  return raw.includes('submit_report');
}

/** What the analyst says, in order: look, read, file. The structured path wants one JSON object. */
const DEFAULT_ANALYST = [
  JSON.stringify({ thought: 'see what was actually sent', tool: 'list_requests', args: {} }),
  JSON.stringify({
    thought: 'read the shape of the failing one',
    tool: 'read_request',
    args: { seq: 1 },
  }),
  JSON.stringify({
    thought: 'file it',
    tool: 'submit_report',
    args: {
      summary: 'The agent sent a tool result block carrying an id the API does not accept there',
      whatHappened:
        'The turn assembled a conversation whose second message opened with a tool result block, ' +
        'and the API rejected it by position before the model saw any of it.',
      whatWentWrong: ['A block was built with a field that block type does not take'],
      rootCause: 'The result of a deferred tool search was written as an ordinary tool result.',
      recommendations: [
        {
          behaviour: 'Validate assembled blocks against the block type before sending',
          rationale: 'The provider will only ever answer with a position, never with a reason',
        },
      ],
      confidence: 'high',
      evidence: ['messages.1.content.0 was the block the API named'],
    },
  }),
  JSON.stringify({ final: 'Filed.' }),
];

/** One `message` response, in the shape the SDK parses. */
function reply(id, text) {
  return JSON.stringify({
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-fake',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    // A cache split, so a walkthrough that reads the receipt sees the shape it expects.
    usage: {
      input_tokens: 1200,
      output_tokens: 40,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
}

/**
 * Start one. Resolves once it is listening.
 *
 * `replies` is consumed in order and the last one repeats, so a walkthrough can script the turns
 * before the failure without counting the retries the SDK makes inside one of them.
 */
export function startFakeAnthropic(opts = {}) {
  const failAfter = opts.failAfter ?? 1;
  const replies = opts.replies?.length ? [...opts.replies] : [DEFAULT_REPLY];
  const analyst = opts.analyst?.length ? [...opts.analyst] : DEFAULT_ANALYST;
  let analystStep = 0;
  const log = opts.log ?? ((line) => process.stdout.write(line + '\n'));
  // Handed the raw body and who sent it. This is the only way to see what a tool call returned,
  // because the result rides in the next request as an observation, and nothing else here reads bodies.
  const inspect = opts.inspect ?? (() => {});
  /** Every call it saw: the path, the size, and what it answered. Never the body. */
  const calls = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const bytes = raw.length;
      if (!req.url?.startsWith('/v1/messages')) {
        calls.push({ path: req.url, bytes, answered: 404 });
        log(`fake-anthropic: ${req.method} ${req.url} — 404`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
        return;
      }

      // The analyst is answered from its own script and never refused, because it is the thing
      // this fake is watching rather than the thing it is testing failure paths against.
      if (isAnalyst(raw)) {
        inspect(raw, 'analyst');
        // Cycled rather than clamped to the last entry. The author may run the report more than
        // once, and a second run that begins at `{"final": …}` never calls `submit_report` — so
        // the analyst answers nothing, which surfaces in the app as an error and reads like a
        // fault in the feature rather than in this script.
        const text = analyst[analystStep++ % analyst.length];
        calls.push({ path: req.url, bytes, answered: 200, who: 'analyst' });
        log(`fake-anthropic: POST /v1/messages (${bytes} B) — 200, analyst step ${analystStep}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(reply(`msg_analyst_${analystStep}`, text));
        return;
      }

      inspect(raw, 'agent');
      const index = calls.filter((c) => c.who === 'agent').length;
      if (index >= failAfter) {
        calls.push({ path: req.url, bytes, answered: 400, who: 'agent' });
        log(`fake-anthropic: POST /v1/messages (${bytes} B) — 400, positional refusal`);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: POSITIONAL_REFUSAL },
          }),
        );
        return;
      }

      const text = replies[Math.min(index, replies.length - 1)];
      calls.push({ path: req.url, bytes, answered: 200, who: 'agent' });
      log(`fake-anthropic: POST /v1/messages (${bytes} B) — 200`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(reply(`msg_fake_${index}`, text));
    });
  });

  return new Promise((ok) => {
    server.listen(opts.port ?? 8788, '127.0.0.1', () => {
      const { port } = server.address();
      ok({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        calls,
        // Forget everything seen so far, `failAfter` included — `calls` *is* the counter. A caller
        // that warms the server up before the run it means to watch (the walkthrough proves the
        // SDK path headlessly first, at the cost of two agent calls) would otherwise start the
        // real run already past its budget, and the app would be refused on its very first turn.
        reset: () => {
          calls.length = 0;
          analystStep = 0;
        },
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Run directly: hold the port until interrupted.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : Number(argv[at + 1]);
  };
  const fake = await startFakeAnthropic({
    port: flag('--port', 8788),
    failAfter: argv.includes('--always-fail') ? 0 : flag('--fail-after', 1),
  });
  process.stdout.write(
    `fake-anthropic: listening on ${fake.baseUrl}\n` +
      `  ANTHROPIC_BASE_URL=${fake.baseUrl} ANTHROPIC_API_KEY=not-a-real-key pnpm vndesktop\n`,
  );
}
