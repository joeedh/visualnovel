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

/**
 * How long a pane is given to load its subject and draw. Reads cross IPC and a disk read, and a
 * character sheet's wardrobe rows wait on the manifest as well, which took a little over 700 ms
 * on 2026-09-21 and left the sheet's asset items out of the file.
 */
const SETTLE_MS = 1200;

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
/** The effects beside the commands. An anchor naming one is drawn by a surface, never checked. */
const effectIds = new Set((catalog.effects ?? []).map((e) => e.id));

const editors =
  catalog.commands.find((c) => c.id === 'view.open')?.props.find((p) => p.name === 'editor')
    ?.values ?? [];

/** The toolbar popups that are anchor homes: the same list as `POPUP_HOMES` in `shared/editors.ts`. */
const POPUP_HOMES = ['notifications', 'approvals', 'diagnostics'];

/**
 * One dumped anchor flattened back into what the offer said. The page hands over a `StdUXMeta`
 * through `nstructjs.writeJSON` — the same tag the derived tier builds — so what a control runs
 * lives in its one tool, and whether it accepts a press lives on the tag itself.
 */
function read(anchor) {
  const tag = anchor.tag ?? {};
  const tool = (tag.tools ?? [])[0] ?? {};
  const supplies = tool.supplies ?? [];
  const then = JSON.parse(tool.then ?? '[]');
  return {
    key       : anchor.key,
    editor    : anchor.editor,
    widgetPath: tag.widgetPath ?? '',
    id        : tool.toolPath ?? '',
    props     : JSON.parse(tool.props ?? '{}'),
    enabled   : tag.enabled !== false,
    reason    : tag.refusal?.reason,
    ...(supplies.length > 0 ? { supplies } : {}),
    ...(tool.form ? { form: true } : {}),
    ...(then.length > 0 ? { then } : {}),
  };
}

/** Whether the anchor omits a prop its command requires. */
function leavesBlank(anchor) {
  const props = catalog.commands.find((c) => c.id === anchor.id)?.props ?? [];
  return props.some((p) => p.required && !(p.name in (anchor.props ?? {})));
}
if (editors.length === 0) throw new Error('view.open declares no editors — is this build current?');

/** What every menu reaches. Derived from the menu table, so no pane has to be opened. */
const records = await evaluate(socket, 'JSON.stringify(window.__vnAnchors.menus())').then(
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
 * command publishes a selection, so nothing but this click reaches one. `badge` narrows the pick
 * to a row whose text carries it, which is how the Page editor is handed a page rather than the
 * first shot. Returns the address clicked, or `''` when the project holds nothing of that kind.
 */
async function select(kind, badge = '') {
  const clicked = await evaluate(
    socket,
    `(() => { const want = ${JSON.stringify(`${kind}/`)}; const badge = ${JSON.stringify(badge)};
      const hit = (root) => {
        for (const node of root.querySelectorAll('[data-anchor]')) {
          if (!node.dataset.anchor.startsWith(want)) continue;
          if (badge === '' || (node.textContent ?? '').includes(badge)) return node;
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

/** Press the twisty of the row anchored `address`, which opens what is under it without selecting it. */
async function expand(address) {
  await evaluate(
    socket,
    `(() => { const want = ${JSON.stringify(address)};
      const hit = (root) => {
        for (const node of root.querySelectorAll('[data-anchor]')) {
          if (node.dataset.anchor === want) return node;
        }
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) { const found = hit(node.shadowRoot); if (found) return found; }
        }
        return null;
      };
      hit(document)?.querySelector('.tv-twisty')?.click();
    })()`,
  );
}

const disagreements = [];
const strays = [];
const drawn = [];
/** Anchors whose control carries no meta tag, which the sweep reports rather than records. */
const untagged = [];
/** Anchors whose control the widget walk does not reach. Empty is the healthy answer. */
const unwalked = [];
/** Named controls the walk found in a home that no live anchor claims, which is information. */
const unclaimed = [];

/**
 * Each live keymap against the shortcut table, by scope. A pane's keymap is live only while the
 * pane is, so this is read after each editor is opened and the last reading of a scope is kept.
 */
const scopes = new Map();
async function noteShortcuts() {
  const report = JSON.parse(
    await evaluate(socket, 'JSON.stringify(window.__vnAnchors.shortcuts?.() ?? [])'),
  );
  for (const scope of report) scopes.set(scope.scope, scope);
}

// The tree first, so a scene and a shot are selected before the panes that follow them are opened.
await run("view.open(editor='documents' where='here')");
await sleep(SETTLE_MS);
const selected = { scene: await select('scene'), shot: '', page: '' };
// A shot row is drawn only once its scene is expanded, which a click on the row does not do — it
// selects — so the scene's twisty is pressed when no shot row is on screen, and the second pass
// waits for the redraw.
await sleep(SETTLE_MS);
selected.shot = await select('shot');
if (!selected.shot && selected.scene) {
  await expand(selected.scene);
  await sleep(SETTLE_MS);
  selected.shot = await select('shot');
  await sleep(SETTLE_MS);
}

/** The badge a page shot's tree row carries, which `storyBranch` writes as `page · N`. */
const PAGE_BADGE = 'page ·';

/** Record every anchor one home draws right now, and ask the stack about each command. */
async function sweepHome(editor) {
  const dump = JSON.parse(await evaluate(socket, 'JSON.stringify(window.__vnAnchors.dump())'));
  const mine = dump.filter((a) => a.editor === editor).map(read);
  // A control the pass anchored but never tagged, which would leave a record with no id at all
  untagged.push(...mine.filter((a) => a.id === '').map((a) => `${editor} ${a.key}`));

  // The third oracle: whether the widget walk reaches every control the passes anchored.
  // `walkWidgets` descends a UIBase's shadow and no other kind of shadow root, so a control
  // mounted under one of those is anchored and unreachable, and lands in `unwalked`.
  const walked = new Set(
    JSON.parse(await evaluate(socket, 'JSON.stringify(window.__vnAnchors.walk())')),
  );
  unwalked.push(...mine.filter((a) => !walked.has(a.widgetPath)).map((a) => `${editor} ${a.key}`));
  const claimed = new Set(mine.map((a) => a.widgetPath));
  unclaimed.push(
    ...[...walked].filter((path) => path.startsWith(`${editor}/`) && !claimed.has(path)),
  );
  const items = mine.filter((a) => a.id === 'ui.publish').length;
  const drawnIds = new Set(mine.map((a) => a.id));
  const undrawn = [...(derivedIds.get(editor) ?? [])]
    .filter((id) => !effectIds.has(id) && !drawnIds.has(id))
    .sort();
  drawn.push({ editor, count: mine.filter((a) => !effectIds.has(a.id)).length, items, undrawn });

  // The second oracle. A box being where it says proves nothing about what a click there reaches:
  // a graph's node layer takes no pointer events, and a widget can be covered. The canvas's own
  // `pick()` answers for one, a shadow-piercing hit test for the other. Only this home's anchors
  // count, since an open popup covers whatever pane is under it by design.
  const strayed = JSON.parse(await evaluate(socket, 'JSON.stringify(window.__vnAnchors.strays())'));
  strays.push(...strayed.filter((stray) => stray.startsWith(`${editor} `)));

  for (const anchor of mine) {
    records.push({
      id: anchor.id,
      editor,
      key       : anchor.key,
      widgetPath: anchor.widgetPath,
      ...(anchor.supplies ? { supplies: anchor.supplies } : {}),
      ...(anchor.form ? { form: true } : {}),
      ...(anchor.then ? { then: anchor.then } : {}),
      ...(anchor.enabled ? {} : { refused: anchor.reason ?? '' }),
    });
    // An effect has no precondition in the stack, so there is nothing to ask. An anchor that
    // supplies a prop is deliberately incomplete, so asking `stack.check` about it asks about the
    // blank the author is on their way to filling in. A `form` anchor's props are a prefill for
    // the same reason: the form is where the author finishes them. `MenuEntry.form` leaves its
    // entries unchecked on that reasoning too.
    if (effectIds.has(anchor.id) || anchor.supplies || anchor.form) continue;
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

for (const editor of editors) {
  const subject = subjectFor[editor] ?? '';
  const where = subject ? ` subject=${JSON.stringify(subject)}` : '';
  // The Page editor claims page shots only, so it is handed one from the expanded scene where the
  // project has one, and the first shot is put back afterwards so the panes after it see what the
  // panes before it saw.
  if (editor === 'page') {
    selected.page = await select('shot', PAGE_BADGE);
    if (selected.page) await sleep(SETTLE_MS);
  }
  await run(`view.open(editor='${editor}' where='here'${where})`);
  await sleep(SETTLE_MS);
  await sweepHome(editor);
  await noteShortcuts();
  if (editor === 'page' && selected.page) {
    await select('shot');
    await sleep(SETTLE_MS);
  }
}

// The toolbar's popups, each opened by pressing the toolbar control that opens it, which is the
// control a `popup-closed` answer rings. Pressing it again closes the popup, since each toggles.
const unopened = [];
for (const popup of POPUP_HOMES) {
  const opener = JSON.stringify(`fx:popup.open#${popup}`);
  const opened = await evaluate(socket, `window.__vnAnchors.press(${opener})`);
  if (!opened) {
    unopened.push(popup);
    continue;
  }
  await sleep(SETTLE_MS);
  await sweepHome(popup);
  await evaluate(socket, `window.__vnAnchors.press(${opener})`);
  await sleep(SETTLE_MS / 2);
}

const named = [...new Set(records.map((r) => r.id))].sort();
const anchored = named.filter((id) => !effectIds.has(id));
const effects = named.filter((id) => effectIds.has(id));
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
      effects,
      records,
      disagreements,
      strays  : [...new Set(strays)].sort(),
      untagged: [...new Set(untagged)].sort(),
      unwalked: [...new Set(unwalked)].sort(),
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
    `the rest are palette-only. ${effects.length} of ${effectIds.size} effects are drawn. ` +
    `Measured against ${under.project || '(no project)'}\n`,
);
for (const popup of unopened) {
  // The problem count is drawn only while validation found something, so a clean project has
  // no control to press
  process.stdout.write(
    `  ${popup}: the toolbar draws no control that opens it, so it was not swept\n`,
  );
}
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
for (const bare of new Set(untagged)) {
  process.stdout.write(`  ⚠ ${bare}: it is anchored, but its control carries no meta tag
`);
}
for (const missed of new Set(unwalked)) {
  process.stdout.write(`  ⚠ ${missed}: it is tagged, but the widget walk does not reach it
`);
}
// Information rather than a finding: a control that is in the document without being drawn keeps
// the tag its last pass wrote, and the composer's Stop button is hidden between turns.
if (unclaimed.length > 0) {
  process.stdout
    .write(`  tagged but not anchored right now: ${[...new Set(unclaimed)].sort().join(' ')}
`);
}
for (const stray of new Set(strays)) {
  process.stdout.write(`  ⚠ ${stray}: it is drawn, but a click in the middle of it lands elsewhere
`);
}
for (const d of disagreements) {
  const about = d.wording ? 'the wording differs: the pane' : 'the pane';
  process.stdout.write(`  ⚠ ${d.editor} ${d.key}: ${about} ${d.pane}; the stack ${d.stack}\n`);
}
// Advisory: the Gen Graph scope is a copy of path.ux's own table, and this is where the copy is
// checked against the pane. Main's two accelerators never reach the renderer, so they have no
// keymap to compare with.
for (const scope of [...new Set(derived.shortcuts.map((s) => s.scope))].sort()) {
  if (scope === 'main') continue;
  const live = scopes.get(scope);
  if (!live) {
    process.stdout.write(`  shortcuts ${scope}: no keymap was live during the sweep\n`);
  } else if (live.missing.length === 0 && live.extra.length === 0) {
    process.stdout.write(`  shortcuts ${scope}: the live keymap agrees with the table\n`);
  } else {
    process.stdout.write(
      `  ⚠ shortcuts ${scope}: the table lists [${live.missing.join(', ')}] the pane does not ` +
        `bind; the pane binds [${live.extra.join(', ')}] the table does not list\n`,
    );
  }
}
process.exit(0);
