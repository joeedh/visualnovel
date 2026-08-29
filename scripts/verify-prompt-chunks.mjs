/**
 * Drive the chunked-prompt editor in a running desktop app and check what it draws
 * (`docs/plans/archive/INDEX.md#chunked-prompts` §18). The pane can only be verified live — the desktop jest
 * project is node-only, so every *rule* is unit-tested and everything below is the wiring.
 *
 * Usage:
 *   pnpm build:desktop && pnpm vndesktop --mock
 *   node scripts/verify-prompt-chunks.mjs
 *
 * It writes: it mutes, replaces, reorders, condenses and hand-writes a prompt on one shot frame,
 * then undoes every one of them back to a project with no override. Steps 11-17 go further — they
 * bring an image into the store, attach references, and **run the pipeline** to move a slot — so
 * point it at a scratch project, not at anything you want to keep.
 *
 * Two facts about the app shape the script. `window.vn.exec` goes preload → main, so the pane's
 * `onInvalidate` never fires for a command driven from here — `refresh()` retoggles the subject
 * instead, and only a *different* hash counts, since `applyView` ignores an empty subject. And the
 * editor's surface lives in an **open** shadow root, so the probe reads `.as-chunk` nodes directly.
 */
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, evaluate, exec, pageTarget, send } from './cdp.mjs';

const socket = await connect(await pageTarget());
const failures = [];

async function step(n, title, fn) {
  try {
    const note = await fn();
    process.stdout.write(`PASS ${String(n).padStart(2)} · ${title}${note ? ` — ${note}` : ''}\n`);
  } catch (error) {
    failures.push(n);
    process.stdout.write(`FAIL ${String(n).padStart(2)} · ${title} — ${error.message}\n`);
  }
}

const ok = (claim, message) => {
  if (!claim) throw new Error(message);
};

/** One command, through the same bridge the DevTools console uses. Throws what it refused. */
async function run(invocation) {
  const outcome = await exec(socket, invocation);
  if (!outcome.ok) throw new Error(`${invocation} → ${outcome.error}`);
  return outcome.data;
}

/** Runs the same call, but expects it to be refused and returns the refusal. */
async function refused(invocation) {
  const outcome = await exec(socket, invocation);
  ok(!outcome.ok, `${invocation} was accepted, and should not have been`);
  return outcome.error;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A plain-data projection of the asset pane. Installed from here rather than shipped in the app:
 * the shadow root is open, so nothing in the renderer has to expose a debug seam for this.
 */
const PROBE = `window.__vnPromptProbe = () => {
  let surface;
  const walk = (root) => {
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.classList && node.classList.contains('as-surface')) surface = node;
    }
  };
  walk(document);
  if (!surface) return { pane: false };
  const text = (node, sel) => (node.querySelector(sel) || { textContent: '' }).textContent;
  return {
    pane: true,
    hash: text(surface, '.as-hash'),
    modes: [...surface.querySelectorAll('.as-mode')].map((b) => ({
      label: b.textContent, on: b.classList.contains('on'), disabled: b.disabled, title: b.title,
    })),
    held: !!surface.querySelector('.as-held'),
    note: text(surface, '.as-note'),
    custom: surface.querySelector('.as-custom textarea') ? surface.querySelector('.as-custom textarea').value : null,
    cards: [...surface.querySelectorAll('.as-chunk')].map((c) => ({
      key: c.dataset.chunk,
      cls: c.className,
      tag: text(c, '.as-chunk-tag'),
      addr: text(c, '.as-chunk-addr'),
      opens: !!c.querySelector('.as-chunk-open'),
      mark: text(c, '.as-chunk-mark'),
      body: text(c, '.as-chunk-text'),
      refs: [...c.querySelectorAll('.as-ref')].map((r) => ({
        cls: r.className,
        title: r.title,
        src: (r.querySelector('img') || {}).src || '',
        name: text(r, '.as-ref-name'),
      })),
    })),
    popups: document.querySelectorAll('body > container-x').length,
  };
};1`;

const probe = () => evaluate(socket, 'JSON.stringify(window.__vnPromptProbe())').then(JSON.parse);

let subject = '';
let decoy = '';
// Step 7 writes an art note to force a re-render under a condensation; step 10 puts it back.
let noteRung = '';
let noteWas = '';

/** Show an asset and wait for the pane to catch up — `load()` trails the command by one read. */
async function show(hash) {
  await run(`view.open(editor='asset' subject='${hash}' where='here')`);
  for (let tries = 0; tries < 40; tries++) {
    const pane = await probe();
    if (pane.pane && pane.hash.startsWith(hash)) return pane;
    await sleep(50);
  }
  throw new Error(`the pane never showed ${hash.slice(0, 8)}`);
}

/** What a click in the app does for free: re-read the asset after a command written from here. */
async function refresh() {
  await show(decoy);
  return show(subject);
}

const info = () => run(`prompt.info(hash='${subject}')`);

/** Wait for the drawn card order to reach `order`, which it does a beat after the command. */
async function settles(order, message) {
  const want = JSON.stringify(order);
  let drawn = '';
  for (let tries = 0; tries < 40; tries++) {
    drawn = JSON.stringify((await probe()).cards.map((c) => c.key));
    if (drawn === want) return;
    await sleep(50);
  }
  throw new Error(`${message} (drawn ${drawn}, stored ${want})`);
}

/** A real gesture, so the pane's own pointer capture and keymap are what answers. */
const mouse = (type, x, y) =>
  send(socket, 'Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1,
    buttons: type === 'mouseReleased' ? 0 : 1,
  });

const rectOf = (selector) =>
  evaluate(
    socket,
    `JSON.stringify((() => {
      let hit;
      const walk = (root) => { for (const n of root.querySelectorAll('*')) { if (n.shadowRoot) walk(n.shadowRoot); if (!hit && n.matches(${JSON.stringify(selector)})) hit = n; } };
      walk(document);
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom };
    })())`,
  ).then(JSON.parse);

/** Click something in the pane by selector and (optionally) by the words on it. */
const click = (selector, label) =>
  evaluate(
    socket,
    `(() => {
      const found = [];
      const walk = (root) => { for (const n of root.querySelectorAll('*')) { if (n.shadowRoot) walk(n.shadowRoot); if (n.matches(${JSON.stringify(selector)})) found.push(n); } };
      walk(document);
      const hit = ${label === undefined ? 'found[0]' : `found.find((n) => n.textContent === ${JSON.stringify(label)})`};
      if (!hit) return false;
      hit.click();
      return true;
    })()`,
  );

await evaluate(socket, PROBE);

// ---------------------------------------------------------------------------

await step(1, 'a shot frame opens in the asset pane', async () => {
  const tree = await run('workspace.doctree()');
  const kinds = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'assetkind') kinds.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of tree.roots) walk(root);

  const shots = kinds.find((k) => k.id === 'assetkind:shot_image');
  ok(
    shots && shots.children.length > 0,
    'this project has no shot frames — run the pipeline first',
  );
  const others = kinds.find((k) => k.id !== 'assetkind:shot_image' && k.children.length > 0);
  ok(others, 'this project has only shot frames, so there is nothing to refresh through');

  subject = shots.children[0].id.replace(/^asset:/, '');
  decoy = others.children[0].id.replace(/^asset:/, '');
  const pane = await show(subject);
  ok(pane.cards.length > 0, 'the pane drew no chunk cards');
  // Every step below reads against the derivation, so an override already on this asset would
  // make them lie rather than fail — start clean or say why not.
  const view = await info();
  ok(
    view.mode === 'chunks' && !view.chunks.some((c) => c.muted || c.edit),
    `${subject.slice(0, 8)} already carries an override (${view.mode} mode) — undo it first`,
  );
  return `${subject.slice(0, 8)}, ${pane.cards.length} clauses`;
});

await step(2, 'the cards are the composition, in order', async () => {
  const view = await info();
  const pane = await probe();
  ok(
    JSON.stringify(pane.cards.map((c) => c.key)) === JSON.stringify(view.chunks.map((c) => c.key)),
    `pane ${pane.cards.map((c) => c.key)} vs prompt.info ${view.chunks.map((c) => c.key)}`,
  );
  for (const card of pane.cards) {
    ok(card.tag !== '', `${card.key} has no tag`);
    ok(/\b(sodium|signal)\b/.test(card.cls), `${card.key} has no voice class`);
  }
  // A sentence the builders wrote has no document behind it, so it offers no way to one.
  for (const chunk of view.chunks) {
    if (chunk.origin.kind !== 'builder') continue;
    const card = pane.cards.find((c) => c.key === chunk.key);
    ok(!card.opens, `${chunk.key} is built in but offers a ⇱`);
  }
  return pane.cards.map((c) => c.key).join(' → ');
});

let muted = '';
await step(3, 'a muted clause leaves the prompt and says so', async () => {
  const view = await info();
  const target =
    view.chunks.find((c) => c.category === 'palette') ??
    view.chunks.filter((c) => c.origin.kind !== 'builder').pop();
  ok(target, 'nothing on this asset is mutable');
  muted = target.key;

  await run(`prompt.setChunk(hash='${subject}' chunk='${muted}' op='mute')`);
  const after = await info();
  ok(!after.text.includes(target.derived), 'the muted sentence is still in the prompt');

  const pane = await refresh();
  const card = pane.cards.find((c) => c.key === muted);
  ok(card.cls.includes('muted'), `${muted} is not drawn muted`);
  return muted;
});

await step(4, 'Ctrl+S in a chunk box saves without opening the palette', async () => {
  const view = await info();
  const target = view.chunks.find((c) => c.key !== muted && c.origin.kind !== 'builder');
  ok(target, 'nothing left to replace');

  ok(
    await click(`.as-chunk[data-chunk="${target.key}"] .as-chunk-act`, 'Replace…'),
    'no Replace… button on the card',
  );
  await sleep(100);
  const typed = 'A verification sentence.';
  const sent = await evaluate(
    socket,
    `(() => {
      let box;
      const walk = (root) => { for (const n of root.querySelectorAll('*')) { if (n.shadowRoot) walk(n.shadowRoot); if (!box && n.matches('.as-chunk[data-chunk="${target.key}"] .as-chunk-box')) box = n; } };
      walk(document);
      if (!box) return false;
      box.focus();
      box.value = ${JSON.stringify(typed)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
  ok(sent, 'the replace box never opened');

  // The save is a command away, so poll for it rather than guessing how long a beat is.
  let chunk;
  for (let tries = 0; tries < 40; tries++) {
    await sleep(100);
    chunk = (await info()).chunks.find((c) => c.key === target.key);
    if (chunk.edit === 'replace' && chunk.text === typed) break;
  }
  const pane = await probe();
  ok(pane.popups === 0, 'a keystroke in the box reached the screen keymap and opened a popup');
  ok(
    chunk.edit === 'replace' && chunk.text === typed,
    `the replacement did not stick: ${chunk.text}`,
  );
  return `${target.key} replaced`;
});

await step(5, 'a clause reorders by keyboard and by drag, and nothing moves early', async () => {
  const before = (await info()).chunks.map((c) => c.key);
  const moving = before[before.length - 1];
  // The keystroke goes to a card, so wait for the pane to be the one the store describes.
  await settles(before, 'the pane never caught up before the nudge');

  await evaluate(
    socket,
    `(() => {
      let card;
      const walk = (root) => { for (const n of root.querySelectorAll('*')) { if (n.shadowRoot) walk(n.shadowRoot); if (!card && n.matches('.as-chunk[data-chunk="${moving}"]')) card = n; } };
      walk(document);
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`,
  );
  let nudged = before;
  for (let tries = 0; tries < 30 && JSON.stringify(nudged) === JSON.stringify(before); tries++) {
    await sleep(100);
    nudged = (await info()).chunks.map((c) => c.key);
  }
  ok(JSON.stringify(nudged) !== JSON.stringify(before), 'Alt+↑ moved nothing');
  // The pane re-reads itself after the command, so it settles a beat behind the store.
  await settles(nudged, 'the pane and prompt.info disagree after the nudge');

  // Now the pointer. The verdict is judged on the grab, so the rule and the sentence appear on
  // the first move — and the list must still be in its old order until the button comes up.
  const rail = await rectOf(`.as-chunk[data-chunk="${nudged[0]}"] .as-chunk-rail`);
  const last = await rectOf(`.as-chunk[data-chunk="${nudged[nudged.length - 1]}"]`);
  ok(rail && last, 'no rail to grab');

  await mouse('mousePressed', rail.x, rail.y);
  await mouse('mouseMoved', rail.x, last.bottom - 2);
  await sleep(150);
  const dragging = await probe();
  ok(
    dragging.cards.some((c) => /drop-(before|after)/.test(c.cls)),
    'no insertion rule appeared under the pointer',
  );
  ok(dragging.note !== '', 'the footer said nothing about the drop');
  ok(
    JSON.stringify(dragging.cards.map((c) => c.key)) === JSON.stringify(nudged),
    'a card moved before pointerup',
  );

  await mouse('mouseReleased', rail.x, last.bottom - 2);
  let dropped = nudged;
  for (let tries = 0; tries < 30 && dropped[dropped.length - 1] !== nudged[0]; tries++) {
    await sleep(100);
    dropped = (await info()).chunks.map((c) => c.key);
  }
  ok(dropped[dropped.length - 1] === nudged[0], `the drop did not land: ${dropped.join(',')}`);
  return dropped.join(' → ');
});

// Under `--mock` the canned answer is the identity condensation over the flattened chunks
// (`session.ts`'s `condensingText`), so what can be checked here is that the structured path ran
// and its answer was stored, not that a model reworded anything.
await step(6, 'condensing writes an agent prompt that covers the clauses', async () => {
  await run(`prompt.condense(hash='${subject}')`);
  const after = await info();
  ok(after.mode === 'agent', `mode is ${after.mode}`);
  // A stored condensation names the model that wrote it: the session refuses to file the
  // deterministic fallback, so provenance here is the proof a model actually answered.
  ok(after.agent && after.agent.modelId, 'no condensation was stored');
  ok(after.text !== '', 'the condensed prompt is empty');
  ok(after.missing.length === 0, `not represented: ${after.missing.join(', ')}`);
  return `${after.chunks.length} clauses, none missing`;
});

await step(7, 'an edit under a condensation holds it rather than re-rendering', async () => {
  const asset = await run(`asset.info(hash='${subject}')`);
  const rung = asset.rungs[asset.rungs.length - 1];
  ok(rung, 'nothing reaches this asset to edit');
  const recorded = asset.prompt;
  noteRung = rung.target;
  noteWas = rung.notes ?? '';

  await run(`art.setNotes(target='${rung.target}' notes='verification note')`);
  const after = await info();
  ok(after.held, 'the condensation is not held');
  ok(after.mode === 'agent', `mode fell back to ${after.mode}`);

  const pane = await refresh();
  ok(pane.held, 'no held banner on screen');
  // Held means the *sent* text did not move, which is the whole point: the bytes' own recorded
  // prompt is untouched, so nothing re-rendered.
  const again = await run(`asset.info(hash='${subject}')`);
  ok(again.prompt === recorded, 'the recorded prompt moved — something re-rendered');
  return rung.target;
});

await step(8, 'a custom prompt is reconciled rather than discarded', async () => {
  const view = await info();
  const written = `${view.text} Handwritten.`;
  await run(`prompt.setCustom(hash='${subject}' text=${JSON.stringify(written)})`);
  ok((await info()).mode === 'custom', 'the custom prompt did not take');

  const reason = await refused(`prompt.condense(hash='${subject}')`);
  ok(reason.includes('force=true'), `the refusal did not name force=true: ${reason}`);

  // With the flag it goes through, and the text an author typed is **kept** — a mode is which
  // stored shape is in force, so Custom returns to these words rather than to a blank box.
  // Whether the *wording* survives into the condensation is the model's job, and the mock's canned
  // answer is the chunks' own words, so that half needs a real key to check.
  await run(`prompt.condense(hash='${subject}' force=true)`);
  const after = await info();
  ok(after.mode === 'agent', `mode is ${after.mode}`);
  ok(after.custom === written, 'the hand-written prompt was discarded rather than kept');
  return 'reconciled, custom kept';
});

await step(9, '⇱ on a project clause opens the project editor', async () => {
  await refresh();
  const view = await info();
  const styled = view.chunks.find((c) => c.origin.kind === 'project');
  ok(styled, 'no clause on this asset comes from project.yaml');

  ok(
    await click(`.as-chunk[data-chunk="${styled.key}"] .as-chunk-open`),
    'the style card offers no ⇱',
  );
  await sleep(600);
  // Every editor lives in a shadow root, so a document-level query would never see one.
  const opened = await evaluate(
    socket,
    `(() => {
      let found = 0;
      const walk = (root) => { for (const n of root.querySelectorAll('*')) { if (n.shadowRoot) walk(n.shadowRoot); if (n.tagName === 'VN-PROJECT-EDITOR-X') found++; } };
      walk(document);
      return String(found);
    })()`,
  );
  ok(Number(opened) > 0, 'no project editor is on screen');
  return `${opened} project pane(s)`;
});

await step(10, 'undo takes the project back to a prompt with no override', async () => {
  let view = await info();
  for (let tries = 0; tries < 30 && view.mode !== 'chunks'; tries++) {
    await evaluate(socket, 'window.vn.undo()');
    view = await info();
  }
  ok(view.mode === 'chunks', `still in ${view.mode} mode after undoing`);

  for (let tries = 0; tries < 30; tries++) {
    const dirty = view.chunks.find((c) => c.muted || c.edit);
    if (!dirty) break;
    await evaluate(socket, 'window.vn.undo()');
    view = await info();
  }
  ok(!view.chunks.some((c) => c.muted || c.edit), 'a clause is still overridden');

  // The art note step 7 wrote is a rung of its own, and undo does not reach across to it.
  if (noteRung) await run(`art.setNotes(target='${noteRung}' notes='${noteWas}')`);
  return `${view.chunks.length} clauses, none overridden`;
});

// ---------------------------------------------------------------------------
// Part II: the reference graph (§18, steps 11-17).

/** A tiny, valid, unmarked PNG on disk. Ingest reads the magic number and the mock marker only. */
async function pngFile() {
  const file = join(tmpdir(), `vn-verify-ref-${process.pid}.png`);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  await writeFile(file, new Uint8Array([...signature, ...new Array(96).fill(7)]));
  return file;
}

let upload = '';
let refChunk = '';
let plate = '';
let plateSlot = '';
let plateNote = '';

await step(11, 'an uploaded image lands in the store with nothing to approve', async () => {
  const file = await pngFile();
  const result = await run(`asset.upload(file=${JSON.stringify(file)} title='Verify moodboard')`);
  upload = result.hash;
  ok(upload, 'the upload reported no hash');

  const info = await run(`asset.info(hash='${upload}')`);
  ok(info.kind === 'reference', `it came in as ${info.kind}`);
  ok(info.accepted === false, 'an upload came in already accepted');
  // The pane's Approve strip is a path.ux widget rather than DOM, so what is checked here is the
  // rule behind it: both acts refuse an upload by name, which is what greys the buttons out.
  const accept = await refused(`asset.accept(hash='${upload}')`);
  ok(accept.includes('prompt.addRef'), `the accept refusal said: ${accept}`);
  const regen = await refused(`asset.regenerate(hash='${upload}')`);
  ok(regen.includes('asset.upload'), `the regenerate refusal said: ${regen}`);
  return `${upload.slice(0, 8)} — ${info.label}`;
});

await step(12, 'a reference attaches to a clause and is drawn under it', async () => {
  const view = await info();
  refChunk = view.chunks[0].key;
  await run(`prompt.addRef(hash='${subject}' chunk='${refChunk}' ref='${upload}')`);

  const after = await info();
  const chunk = after.chunks.find((c) => c.key === refChunk);
  ok(chunk.refs && chunk.refs.length === 1, 'prompt.info lists no reference');
  ok(chunk.refs[0].pin === upload, `it pinned ${chunk.refs[0].pin}`);
  // A bare hash pins itself: there is no slot under it, so it can never drift.
  ok(!chunk.refs[0].from, 'an upload was recorded as following a slot');

  const pane = await refresh();
  const card = pane.cards.find((c) => c.key === refChunk);
  ok(card.refs.length === 1, 'the card drew no reference strip');
  ok(card.refs[0].src.includes(upload), `the thumbnail loads ${card.refs[0].src}`);
  ok(card.refs[0].title.includes('follows nothing'), `the tooltip said: ${card.refs[0].title}`);
  return `${refChunk} ← ${upload.slice(0, 8)}`;
});

await step(13, 'a linked reference suspends what it is under when its slot moves', async () => {
  // The shot already references a plate; attaching it *by slot* is what makes the link authored,
  // and therefore what a repin can move.
  const suspects = await run('asset.suspended()');
  ok(suspects.length === 0, `${suspects.length} asset(s) were already suspended`);

  const assets = await run('workspace.doctree()');
  const plates = [];
  const walk = (node) => {
    if (node.kind === 'assetkind' && node.id === 'assetkind:location_ref') {
      plates.push(...node.children);
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of assets.roots) walk(root);
  ok(plates.length > 0, 'this project has no location plates');
  plate = plates[0].id.replace(/^asset:/, '');

  const plateInfo = await run(`asset.info(hash='${plate}')`);
  const rung = plateInfo.rungs[plateInfo.rungs.length - 1];
  const [, rest] = rung.target.split(':');
  const [locationId, variant] = rest.split('/');
  ok(variant, `${rung.target} does not name a variant`);
  plateSlot = `plate:${locationId}/${variant}`;
  plateNote = rung.target;

  await run(`prompt.addRef(hash='${subject}' chunk='${refChunk}' ref='${plateSlot}')`);
  const linked = (await info()).chunks
    .find((c) => c.key === refChunk)
    .refs.find((r) => r.pin === plate);
  ok(linked, `${plateSlot} was not pinned to ${plate.slice(0, 8)}`);
  ok(linked.from === plateSlot, `it recorded ${linked.from}`);

  // Move the slot: an art note on the variant re-keys the plate, so the next run draws a new one.
  await run(`art.setNotes(target='${plateNote}' notes='verification: warmer key light')`);
  await run('pipeline.run(mock=false)');

  const suspended = await run('asset.suspended()');
  const mine = suspended.find((s) => s.hash === subject);
  ok(mine, `nothing suspended names ${subject.slice(0, 8)}: ${suspended.length} entries`);
  ok(mine.reason.includes(plateSlot), `the reason said: ${mine.reason}`);
  return mine.reason;
});

await step(14, 'a suspended asset refuses to be accepted', async () => {
  const reason = await refused(`asset.accept(hash='${subject}')`);
  ok(reason.includes('suspended'), `the refusal said: ${reason}`);
  return reason;
});

await step(
  15,
  'repinning without regenerating adopts the bytes rather than redrawing',
  async () => {
    const before = await run(`asset.info(hash='${subject}')`);
    await run(
      `prompt.repin(hash='${subject}' chunk='${refChunk}' ref='${plate}' regenerate=false)`,
    );

    const after = await run(`asset.info(hash='${subject}')`);
    ok(after.hash === before.hash, 'the bytes moved — something re-rendered rather than adopting');
    const repinned = (await info()).chunks
      .find((c) => c.key === refChunk)
      .refs.find((r) => r.from === plateSlot);
    ok(repinned.pin !== plate, 'the pin did not move');

    const still = (await run('asset.suspended()')).find((s) => s.hash === subject);
    ok(!still, `it is still suspended: ${still && still.reason}`);
    // Adoption logs the newly-keyed task `done` with these bytes, so the planner wants nothing.
    const status = await run('pipeline.run(mock=true)');
    ok(status.preview.pendingTasks === 0, `${status.preview.pendingTasks} task(s) still planned`);
    return `${before.hash.slice(0, 8)} kept, repinned to ${repinned.pin.slice(0, 8)}`;
  },
);

await step(16, 'a reference that would close a cycle is refused, by path', async () => {
  const shot = (await run(`asset.info(hash='${subject}')`)).rungs.find((r) =>
    r.target.startsWith('shot:'),
  );
  ok(shot, 'this asset has no shot rung to close a cycle through');
  const [sceneId, shotId] = shot.target.slice('shot:'.length).split('/');

  // The shot already reaches the plate, so pointing the plate back at the shot closes the loop.
  const chunk = (await run(`prompt.info(hash='${plate}')`)).chunks[0].key;
  const verdict = await evaluate(
    socket,
    `JSON.stringify(window.vn.check('prompt.addRef', { hash: '${plate}', chunk: '${chunk}', ref: 'shot:${sceneId}/${shotId}' }))`,
  ).then(JSON.parse);
  ok(verdict.ok === false, 'stack.check accepted a reference that closes a cycle');
  ok(verdict.reason.includes('→'), `the refusal named no path: ${verdict.reason}`);
  ok(verdict.reason.includes(plateSlot), `the path does not name the plate: ${verdict.reason}`);
  await refused(`prompt.addRef(hash='${plate}' chunk='${chunk}' ref='shot:${sceneId}/${shotId}')`);
  return verdict.reason;
});

await step(17, 'undo takes the reference graph back to empty', async () => {
  let view = await info();
  for (let tries = 0; tries < 30 && view.chunks.some((c) => c.refs && c.refs.length); tries++) {
    await evaluate(socket, 'window.vn.undo()');
    view = await info();
  }
  ok(!view.chunks.some((c) => c.refs && c.refs.length), 'a reference is still attached');
  ok(view.mode === 'chunks', `the prompt is in ${view.mode} mode`);

  // The art note is a rung of its own and undo does not reach across to it, same as step 10.
  if (plateNote) await run(`art.setNotes(target='${plateNote}' notes='')`);
  return `${view.chunks.length} clauses, no references`;
});

socket.close();
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} step(s) failed: ${failures.join(', ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nAll 17 steps passed.\n');
}
