/**
 * Measure which commands the app's drawn surfaces reach, in a running desktop app, and write
 * `apps/desktop/anchors.json` (`docs/reference/guided-tours.md`).
 *
 * Usage, in two shells, since the launcher keeps running and announces the port it opened:
 *   pnpm build:desktop && pnpm vndesktop --mock --project <dir>
 *   VN_CDP_PORT=<that port> node scripts/sweep-anchors.mjs [--window 0]
 *
 * Read-only: it opens each editor in turn and runs `command:check`, and nothing it runs mutates
 * the project. The pane it cycles through is whichever one was active, so the arrangement is left
 * as it was found apart from that pane.
 *
 * Advisory rather than a gate. CI has no app, no CDP port and no workspace, so the half that can
 * run there reads the file this writes — see `apps/desktop/src/main/tests/anchorcoverage.test.ts`.
 * Nothing regenerates the file on its own, so run this whenever the work touched
 * `apps/desktop/renderer/pathux/editors/**`.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT as root } from './aliases.mjs';
import { connect, evaluate, exec, pageTarget } from './cdp.mjs';

const OUT = resolve(root, 'apps/desktop/anchors.json');

/**
 * The derived model (`pnpm gen:uxmodel`), read for two things: which `(editor, id)` pairs some
 * record marks `reasonFrom: 'stack'`, whose measured wording must then equal the stack's verdict,
 * and how many derived command ids each editor has, so the sweep can say how much of it was drawn.
 */
const derived = JSON.parse(await fs.readFile(resolve(root, 'apps/desktop/ux-model.json'), 'utf8'));
const stackWorded = new Set(
  derived.records
    .filter((r) => r.via === 'control' && r.reasonFrom === 'stack')
    .map((r) => `${r.editor} ${r.offer.id}`),
);
const derivedIds = new Map();
for (const record of derived.records) {
  if (record.via !== 'control') continue;
  if (!derivedIds.has(record.editor)) derivedIds.set(record.editor, new Set());
  derivedIds.get(record.editor).add(record.offer.id);
}

/** How long a pane is given to load its subject and draw. Reads cross IPC and a disk read. */
const SETTLE_MS = 700;

const windowArg = process.argv.indexOf('--window');
const socket = await connect(
  await pageTarget(windowArg < 0 ? 0 : Number(process.argv[windowArg + 1])),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(invocation) {
  const outcome = await exec(socket, invocation);
  if (!outcome.ok) throw new Error(`${invocation} → ${outcome.error}`);
  return outcome.data;
}

const catalog = await evaluate(socket, 'window.vn.catalog()');
const commands = catalog.commands.map((c) => c.id).sort();

const editors =
  catalog.commands.find((c) => c.id === 'view.open')?.props.find((p) => p.name === 'editor')
    ?.values ?? [];

/** Whether the anchor omits a prop its command requires. */
function leavesBlank(anchor) {
  const props = catalog.commands.find((c) => c.id === anchor.id)?.props ?? [];
  return props.some((p) => p.required && !(p.name in (anchor.props ?? {})));
}
if (editors.length === 0) throw new Error('view.open declares no editors — is this build current?');

/** What the tree's right-click reaches. Derived from `menuFor`, so no pane has to be opened. */
const records = await evaluate(socket, 'JSON.stringify(window.__vnAnchors.tree())').then(
  JSON.parse,
);

/**
 * Something for each pane to be about. Half the controls in the app are drawn only once a subject
 * is on screen, so a sweep that opened every editor empty would report the app as almost entirely
 * palette-only. The subjects come from the project's own tree, so a project holding none of a kind
 * simply measures nothing for the panes that need one.
 */
async function subjects() {
  const tree = await run('workspace.doctree()');
  const first = {};
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      first[node.kind] ??= node;
      walk(node.children);
    }
  };
  walk(tree.roots ?? tree);
  const key = (kind) => (first[kind] ? first[kind].id.slice(first[kind].id.indexOf(':') + 1) : '');
  return {
    asset    : key('asset'),
    wiki     : first['character']?.path ?? first['location']?.path ?? '',
    skills   : first['skill']?.path ?? '',
    gengraph : key('graph'),
    taskgraph: key('slot'),
  };
}

const subjectFor = await subjects();

/**
 * Click the tree row that names something, so the panes following `ui.sceneId` and `ui.shotId`
 * have a subject too. `view.open`'s `subject` carries only a path and an asset hash, and no
 * command publishes a selection, so nothing but this click reaches one. Returns the address
 * clicked, or `''` when the project holds nothing of that kind.
 */
async function select(kind) {
  const clicked = await evaluate(
    socket,
    `(() => { const want = ${JSON.stringify(`${kind}/`)};
      const hit = (root) => {
        for (const node of root.querySelectorAll('[data-anchor]')) {
          if (node.dataset.anchor.startsWith(want)) return node;
        }
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) { const found = hit(node.shadowRoot); if (found) return found; }
        }
        return null;
      };
      const row = hit(document);
      if (!row) return '';
      row.click();
      return row.dataset.anchor;
    })()`,
  );
  return clicked;
}

const disagreements = [];
const strays = [];
const drawn = [];

// The tree first, so a scene and a shot are selected before the panes that follow them are opened.
await run("view.open(editor='documents' where='here')");
await sleep(SETTLE_MS);
const selected = { scene: await select('scene'), shot: '' };
// A shot row is drawn only once its scene is expanded, and a scene expands when it is clicked, so
// the second pass has to wait for the redraw the first one asked for.
await sleep(SETTLE_MS);
selected.shot = await select('shot');

for (const editor of editors) {
  const subject = subjectFor[editor] ?? '';
  const where = subject ? ` subject=${JSON.stringify(subject)}` : '';
  await run(`view.open(editor='${editor}' where='here'${where})`);
  await sleep(SETTLE_MS);
  const dump = JSON.parse(await evaluate(socket, 'JSON.stringify(window.__vnAnchors.dump())'));
  const mine = dump.filter((a) => a.editor === editor && a.id !== undefined);
  const items = dump.filter((a) => a.editor === editor && a.id === undefined).length;
  const drawnIds = new Set(mine.map((a) => a.id));
  const undrawn = [...(derivedIds.get(editor) ?? [])].filter((id) => !drawnIds.has(id)).sort();
  drawn.push({ editor, count: mine.length, items, undrawn });

  // The second oracle. A box being where it says proves nothing about what a click there reaches:
  // a graph's node layer takes no pointer events, and a widget can be covered. The canvas's own
  // `pick()` answers for one, a shadow-piercing hit test for the other.
  strays.push(...JSON.parse(await evaluate(socket, 'JSON.stringify(window.__vnAnchors.strays())')));

  for (const anchor of mine) {
    records.push({
      id: anchor.id,
      editor,
      key: anchor.key,
      ...(anchor.supplies ? { supplies: anchor.supplies } : {}),
      ...(anchor.form ? { form: true } : {}),
      ...(anchor.enabled ? {} : { refused: anchor.reason ?? '' }),
    });
    // An anchor that supplies a prop is deliberately incomplete, so asking `stack.check` about it
    // asks about the blank the author is on their way to filling in. A `form` anchor's props are a
    // prefill for the same reason: the form is where the author finishes them. `MenuEntry.form`
    // leaves its entries unchecked on that reasoning too.
    if (anchor.supplies || anchor.form) continue;
    const verdict = await evaluate(
      socket,
      `window.vn.check(${JSON.stringify(anchor.id)}, ${JSON.stringify(anchor.props)})`,
    );
    // `undeclared` is not permission, so it is not an opinion this can disagree with either.
    if (verdict.state === 'undeclared') continue;
    // A refusal the derived model says is worded by the stack has to carry the stack's sentence.
    // A refused offer carries no props, so where the command requires one the stack was asked
    // about the blank, and its answer is not the sentence the pane echoed.
    if (
      !anchor.enabled &&
      verdict.state === 'refuse' &&
      stackWorded.has(`${editor} ${anchor.id}`) &&
      !leavesBlank(anchor) &&
      anchor.reason !== verdict.message
    ) {
      disagreements.push({
        editor,
        key    : anchor.key,
        pane   : `refuses it — ${anchor.reason ?? ''}`,
        stack  : `refuses it — ${verdict.message ?? ''}`,
        wording: true,
      });
      continue;
    }
    if (anchor.enabled === (verdict.state === 'accept')) continue;
    disagreements.push({
      editor,
      key  : anchor.key,
      pane : anchor.enabled ? 'offers it' : `refuses it — ${anchor.reason ?? ''}`,
      stack: verdict.state === 'accept' ? 'accepts it' : `refuses it — ${verdict.message ?? ''}`,
    });
  }
}

const anchored = [...new Set(records.map((r) => r.id))].sort();
const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

const index = await run('workspace.index()');

// Whether a control is drawn at all depends on what the pane was showing, so the file says which
// project it was measured against instead of reading as total.
const under = { project: index.title ?? '', selected };

await fs.writeFile(
  OUT,
  JSON.stringify(
    {
      sweptAt: new Date().toISOString(),
      gitSha,
      under,
      commands,
      anchored,
      records,
      disagreements,
      strays: [...new Set(strays)].sort(),
    },
    null,
    2,
  ) + '\n',
);

// `pnpm lint` checks this file's formatting like any other, and `JSON.stringify` breaks every
// array across lines where prettier would keep a short one inline.
execFileSync('pnpm', ['exec', 'prettier', '--write', OUT], {
  cwd  : root,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});

process.stdout.write(
  `anchors.json: ${anchored.length} of ${commands.length} commands have a UI anchor; ` +
    `the rest are palette-only. Measured against ${under.project || '(no project)'}\n`,
);
for (const { editor, count, items, undrawn } of drawn) {
  if (count === 0) {
    const item = items > 0 ? ` (${items} subjects to click, and no command)` : '';
    process.stdout.write(`  ${editor}: draws no command anchor yet${item}\n`);
  }
  // Information rather than a finding: the situations list controls the swept project may not
  // have had a subject for, and plan 7 is what closes that gap.
  if (undrawn.length > 0) {
    process.stdout.write(
      `  ${editor}: ${undrawn.length} derived command(s) not drawn: ${undrawn.join(' ')}\n`,
    );
  }
}
for (const editor of [...derivedIds.keys()].sort()) {
  if (drawn.some((d) => d.editor === editor)) continue;
  process.stdout.write(
    `  ${editor}: not swept (${derivedIds.get(editor).size} derived commands)\n`,
  );
}
for (const stray of new Set(strays)) {
  process.stdout.write(`  ⚠ ${stray}: it is drawn, but a click in the middle of it lands elsewhere
`);
}
for (const d of disagreements) {
  const about = d.wording ? 'the wording differs: the pane' : 'the pane';
  process.stdout.write(`  ⚠ ${d.editor} ${d.key}: ${about} ${d.pane}; the stack ${d.stack}\n`);
}
process.exit(0);
