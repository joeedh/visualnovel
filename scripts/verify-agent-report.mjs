/**
 * Walk the whole of "the API refused the turn, so the app offered to look into it" — from the
 * refusal, through the dialog that opens by itself, to the GitHub form the author presses Create
 * on (`docs/plans/archive/diagnosing-an-api-error-from-the-request-that-caused-it.md` § Testing).
 *
 * **Half harness, half instructions**, because the path cannot be driven entirely from outside.
 * `renderer/pathux/report.ts` says why: `window.vn.exec` invokes main directly, so a turn sent
 * over CDP never reaches the renderer's `ask()` — and the dialog opening by itself is a *renderer*
 * behaviour. So the script scaffolds, launches and asserts; the author types the turn, takes the
 * offer, and presses the buttons.
 *
 * Usage:
 *   node scripts/verify-agent-report.mjs          # no key, no bill: it talks to a fake API
 *
 * Deliberately **not** in `package.json`'s scripts and never run by `pnpm test`, like its siblings
 * `verify-prompt-cache.mjs` and `verify-prompt-chunks.mjs`. It needs `pnpm build` to have been run,
 * because it launches the built app.
 *
 * Nothing here costs money. `scripts/fake-anthropic.mjs` answers on loopback, reached through
 * `ANTHROPIC_BASE_URL`, which the SDK honours on its own. It is not `--mock`: `--mock` makes no
 * calls at all and `previewReport` refuses to analyse under it. Because the binding is real, a key
 * still has to resolve — so a dummy `ANTHROPIC_API_KEY` is set for the child, and like every key
 * in this repo it is never printed.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { alias, EXTERNAL, REPO_ROOT as root } from './aliases.mjs';
import { startFakeAnthropic } from './fake-anthropic.mjs';
import { connect, evaluate, pageTarget } from './cdp.mjs';

const CDP_PORT = 9299;
// Not just the app's port — ours too. `cdp.mjs` reads `VN_CDP_PORT` off this process when it dials,
// so without this the checks at the end look for the app on 9222 and report it as not listening.
process.env.VN_CDP_PORT = String(CDP_PORT);
/** The model the scaffolded project binds. Anything Anthropic: the fake answers all of them. */
const MODEL = 'claude-opus-4-8';

/**
 * A terminal to ask into, or none.
 *
 * There often is none — run under a tool, an agent shell or a CI job, stdin is a closed pipe and
 * `readline` throws `ERR_USE_AFTER_CLOSE` on the first question. That is not a reason to refuse:
 * the manual steps are the same either way, so without a terminal they are all printed at once
 * and the script waits for a **sentinel file** instead of for Enter. One wait rather than five,
 * because the per-step Enter was only ever pacing — every assertion runs after the last step.
 */
const interactive = Boolean(process.stdin.isTTY);
const rl = interactive
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;
const results = [];
/** Without a terminal, the steps as they are declared — printed together by `handOver`. */
const pending = [];

const say = (line = '') => process.stdout.write(line + '\n');
const step = (n, text) => {
  if (rl) return rl.question(`\n  ${n}. ${text}\n     [Enter when done] `);
  pending.push(`  ${n}. ${text}`);
  return Promise.resolve();
};

/** Print every step at once, then poll for the file the author writes when they have finished. */
async function handOver(dir) {
  if (interactive) return;
  const sentinel = join(dir, 'WALKTHROUGH-DONE');
  for (const line of pending) say('\n' + line);
  say('');
  say('  There is no terminal to press Enter into, so say you are done by creating this file:');
  say('');
  say('      ' + sentinel);
  say('');
  // Single-quoted rather than JSON-quoted: a Windows path through `JSON.stringify` comes out with
  // every separator doubled, which is a valid string and the wrong path.
  say(`  PowerShell:  New-Item -ItemType File '${sentinel}'`);
  say('  Waiting (up to 40 minutes)...');
  const until = Number(process.env.VN_WALKTHROUGH_TIMEOUT_MS ?? 40 * 60 * 1000);
  for (let waited = 0; waited < until; waited += 2000) {
    if (await fs.stat(sentinel).catch(() => null)) return;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  say('  Gave up waiting. Checking anyway — expect failures if the steps were not done.');
}

/** One assertion, recorded and printed as it is made. */
function check(name, passed, detail = '') {
  results.push({ name, passed });
  say(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Copy `templates/basic` somewhere disposable and bind it to an Anthropic model. */
async function scaffold() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'vn-report-'));
  await fs.cp(resolve(root, 'templates/basic'), dir, { recursive: true });

  const yamlPath = join(dir, 'project.yaml');
  const yaml = await fs.readFile(yamlPath, 'utf8');
  await fs.writeFile(yamlPath, yaml.replace(/^(\s*text:).*$/m, `$1 ${MODEL}`), 'utf8');

  // The app is git-backed — threads, notifications and the command log all live in a worktree —
  // so a project that was never a repository is not the project this path runs against.
  const git = (...args) =>
    new Promise((ok) => spawn('git', args, { cwd: dir, stdio: 'ignore' }).on('exit', ok));
  await git('init', '-q');
  await git('add', '-A');
  await git(
    '-c',
    'user.name=verify',
    '-c',
    'user.email=verify@localhost',
    'commit',
    '-qm',
    'scaffold',
  );
  return dir;
}

/** Every name the report must not contain, read off the project rather than assumed. */
async function names(dir) {
  const found = new Set();
  const yaml = await fs.readFile(join(dir, 'project.yaml'), 'utf8');
  const title = /^title:\s*(.+)$/m.exec(yaml)?.[1]?.trim();
  if (title) found.add(title);
  for (const entry of await fs.readdir(join(dir, 'characters'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const md = await fs.readFile(join(dir, 'characters', entry.name, 'character.md'), 'utf8');
    const name = /^#\s*(.+)$/m.exec(md)?.[1]?.trim() ?? entry.name;
    found.add(name);
  }
  return [...found].filter((n) => n.length > 3);
}

/** Evaluate one expression in the app's first window. A fresh socket per call, like `vn-cdp`. */
async function inApp(expression) {
  const socket = await connect(await pageTarget(0));
  try {
    return await evaluate(socket, expression);
  } finally {
    socket.close();
  }
}

const dsl = (text) => inApp(`window.vn.exec(${JSON.stringify(text)})`);

/**
 * Before the window: prove headlessly that a real SDK failure against the fake endpoint is read
 * the way the whole feature assumes.
 *
 * It has to be a script rather than a jest test — the Anthropic SDK is imported lazily and
 * dynamically, which jest's CJS VM refuses without `--experimental-vm-modules`. Bundled into
 * `packages/providers` for the same reason `verify-prompt-cache.mjs` does it: the model SDKs are
 * `EXTERNAL`, and `@anthropic-ai/sdk` is a dependency of that package alone.
 */
async function preflight(baseUrl) {
  const entry = resolve(root, 'packages/providers/.report-entry.cjs');
  await build({
    stdin: {
      contents: [
        "export { createAnthropicChat } from '@vn/providers';",
        "export { faultKind, captureSnapshot, clearCaptures } from '@vn/providers';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    alias,
    external: EXTERNAL,
    logLevel: 'warning',
  });

  const vn = createRequire(import.meta.url)(entry);
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  vn.clearCaptures();
  const chat = vn.createAnthropicChat('not-a-real-key', MODEL);

  const answered = await chat.message({ prompt: 'say hello' });
  check('a real call reaches the fake API and comes back', answered.length > 0);
  const first = vn.captureSnapshot();
  check(
    'the request it sent was captured, body and all',
    first.headers().length === 1 &&
      (first.body(first.headers()[0].seq) ?? '').includes('say hello'),
  );

  const err = await chat.message({ prompt: 'say hello again' }).then(
    () => undefined,
    (e) => e,
  );
  // The whole feature depends on this reading: a 400 whose only content is a position counts as
  // a fault in the request, and a fault in the request is the one kind the app offers to look into.
  check(
    'a positional 400 reads as a fault in the request',
    vn.faultKind(err) === 'request',
    String(vn.faultKind(err)),
  );
  const after = vn.captureSnapshot().headers();
  check(
    'the failure was filed on the entry that caused it, once',
    after.length === 2 && (after[1].error ?? '').includes('messages.1.content.0'),
    `${after.length} entr(ies)`,
  );

  delete process.env.ANTHROPIC_BASE_URL;
  await fs.rm(entry, { force: true });
}

// ── Set up ───────────────────────────────────────────────────────────────────────────────────

if (!(await fs.stat(resolve(root, 'apps/desktop/dist')).catch(() => null))) {
  say('verify-agent-report: apps/desktop/dist is missing — run `pnpm build` first.');
  process.exit(2);
}

const dir = await scaffold();
const forbidden = await names(dir);

/** What the fake noticed in the analyst's own requests: its observations ride in the next one. */
const seen = { listedRequests: false, sawOutline: false };
const fake = await startFakeAnthropic({
  port: 0,
  failAfter: 1,
  inspect: (raw, who) => {
    if (who !== 'analyst') return;
    // The result of a tool call comes back as the *next* request's observation, so what
    // `list_requests` and `read_request` actually returned is only visible from here.
    if (raw.includes('convo') && raw.includes('FAILED:')) seen.listedRequests = true;
    if (raw.includes('/messages/') && raw.includes('role=')) seen.sawOutline = true;
  },
  log: () => {},
});

say('');
say('  Checking the plumbing before the window goes up:');
say('');
await preflight(fake.baseUrl);
// The preflight spent two agent calls proving the SDK path, and `failAfter` is counted off the
// same list. Without this the app is refused on its first turn instead of its second, and the
// walkthrough's step 1 has nothing to show.
fake.reset();

say('');
say('  Project:   ' + dir);
say('  Fake API:  ' + fake.baseUrl + '  (nothing leaves this machine, nothing is billed)');
say('  CDP:       127.0.0.1:' + CDP_PORT);

const app = spawn('pnpm', ['exec', 'electron', '.', '--project', dir], {
  cwd: resolve(root, 'apps/desktop'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    VN_CDP_PORT: String(CDP_PORT),
    ANTHROPIC_BASE_URL: fake.baseUrl,
    // Real binding, fake endpoint — so a key still has to resolve. Never printed.
    ANTHROPIC_API_KEY: 'not-a-real-key',
  },
});
app.on('error', (err) => {
  say(`verify-agent-report: could not launch the app: ${err.message}`);
  process.exit(1);
});

// ── The part only a person can do ────────────────────────────────────────────────────────────

say('');
say('  The app is starting. Everything below happens in its window — the automatic dialog is a');
say('  renderer behaviour, so driving it from here would not be testing it.');

await step(
  1,
  'Open the agent pane and send any turn (“what happens in the first scene?”).\n     It should answer: the fake API allows exactly one call.',
);
await step(
  2,
  'Send a second turn. The API refuses this one by position.\n     Confirm the recovery card offers “Stop, and look into what went wrong”.',
);
await step(
  3,
  'Take that choice.\n     Confirm a “Report a difficult agent” dialog opens BY ITSELF, that it names the\n     conversation, that BOTH reading boxes are ticked, and that a sentence above the\n     fields says why it opened.',
);
await step(
  4,
  'Run it.\n     Confirm a report preview opens and reads as a diagnosis of the refusal.',
);
await step(
  5,
  'Press “Open a GitHub issue on this report”.\n     Confirm your browser opens a NEW ISSUE FORM, already filled in, on a repository —\n     and that nothing was posted. Press Create there if you want the issue; the app\n     never posts one for you.',
);

await handOver(dir);

// ── What the machine can check ───────────────────────────────────────────────────────────────

say('');
say('  Checking what the app and the fake API recorded:');
say('');

const agentCalls = fake.calls.filter((c) => c.who === 'agent');
check(
  'the API was really called, and really refused one by position',
  agentCalls.some((c) => c.answered === 200) && agentCalls.some((c) => c.answered === 400),
  `${agentCalls.length} agent call(s)`,
);
check('the analyst listed the captured requests, and got the failure back', seen.listedRequests);
check('the analyst read one, and got its structure rather than its content', seen.sawOutline);

const threads = await dsl('agent.threads()');
const thread = threads?.data?.threads?.[0]?.id;
check('the conversation was recorded', Boolean(thread), thread ?? 'none found');

// Run it once more from here, which is the only way to read the drafted report back: the dialog
// hands its draft to the preview, not to us. It costs nothing — the fake answers the analyst.
const rerun = thread
  ? await dsl(`report.agent(thread='${thread}' source=true detail=true)`)
  : undefined;
const body = rerun?.data?.body ?? '';
check(
  'a report was drafted',
  Boolean(body),
  body ? `${body.length} chars` : String(rerun?.message ?? ''),
);
check('it read the source', Boolean(rerun?.data?.report?.readSource));

const leaked = forbidden.filter((name) => body.includes(name));
check(
  'nothing from the fiction is in the report',
  body.length > 0 && leaked.length === 0,
  leaked.length ? `found: ${leaked.join(', ')}` : `checked ${forbidden.length} name(s)`,
);
// This feature reads the requests on the author's own key, and nothing read that way appears in
// what gets posted. Those two facts together are its whole privacy guarantee.
check(
  'nothing from the captured requests is in the report',
  body.length > 0 && !body.includes('tool_search_tool_result'),
);

if (body) {
  say('');
  say('  ── The drafted report ' + '─'.repeat(52));
  say(body.split('\n').slice(0, 40).join('\n'));
  say('  ' + '─'.repeat(72));
}

// ── Done ─────────────────────────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.passed);
say('');
say(`  ${results.length - failed.length}/${results.length} checks passed.`);
say(`  The project is still at ${dir} — delete it when you are done with it.`);

await rl.question('\n  [Enter to close the app] ');
app.kill();
await fake.stop();
rl?.close();
process.exitCode = failed.length ? 1 : 0;
