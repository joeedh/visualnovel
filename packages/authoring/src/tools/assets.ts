// ── Planned art: what exists, how it was directed, and drawing it again ─────
import { z } from 'zod';
import {
  assetApproved,
  assetSlotLabel,
  openTakeDeps,
  repairCurrent,
  rungsFor,
  setArtNotes,
  type NotesMode,
} from '@vn/artgen';
import { loadConfig } from '@vn/config';
import { AssetStore, readShots } from '@vn/store';
import { exists } from '@vn/util';
import { bindsTo, type Asset, type ProjectModel, type Shot } from '@vn/types';
import {
  SAID_WINDOW,
  approvalCard,
  offlineTriage,
  triageApprovals,
  unapprovalCard,
  type Approvable,
  type ApprovalControl,
  type ApprovalDirection,
  type ApprovalTriage,
} from '../approve.js';
import type { Workspace } from '../workspace.js';
import { ok, fail, rel, type Tool } from './core.js';

/** What `list_assets` is asked about. The three things a picture in this project can be of. */
type AssetSubject = { characterId: string } | { locationId: string } | { sceneId: string };

/** Parse `character:aiko` / `location:cafe` / `scene:greet`; `undefined` for anything else. */
function parseAssetSubject(ref: string): AssetSubject | undefined {
  const cut = ref.indexOf(':');
  if (cut <= 0) return undefined;
  const id = ref.slice(cut + 1).trim();
  if (!id) return undefined;
  if (ref.startsWith('character:')) return { characterId: id };
  if (ref.startsWith('location:')) return { locationId: id };
  if (ref.startsWith('scene:')) return { sceneId: id };
  return undefined;
}

/** Find an asset by hash or by a prefix of one. An ambiguous prefix is refused with its
 *  candidates rather than resolved by guessing. */
function findAsset(
  assets: readonly Asset[],
  said: string,
): { ok: true; asset: Asset } | { ok: false; error: string } {
  const hash = said.trim().toLowerCase();
  const matches = assets.filter((a) => a.hash === hash || a.hash.startsWith(hash));
  if (matches.length === 0) {
    return {
      ok   : false,
      error: `no asset starts with "${said}" — run list_assets to see what there is.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok   : false,
      error: `"${said}" names ${matches.length} assets (${matches.map((m) => m.hash.slice(0, 12)).join(', ')}); say more of the hash.`,
    };
  }
  return { ok: true, asset: matches[0]! };
}

/** The storyboards for the scenes named, in the shape `rungsFor` reads them. */
async function shotsFor(
  workspace: Workspace,
  model: ProjectModel,
  sceneIds: readonly string[],
): Promise<Map<string, readonly Shot[] | null>> {
  const shots = new Map<string, readonly Shot[] | null>();
  for (const id of sceneIds) {
    const scene = model.scenes.get(id);
    if (!scene) continue;
    const ids = new Set(scene.lines.map((l) => l.id));
    const loaded = await readShots(workspace.paths, id, ids).catch(() => null);
    shots.set(id, loaded?.shots ?? null);
  }
  return shots;
}

/**
 * The manifest with `current` made true to the task log first, the way every other host opens a
 * project. A project whose `project.yaml` will not load has no slot identities to repair against,
 * so its manifest is read as it stands.
 */
async function repairedStore(workspace: Workspace, model: ProjectModel): Promise<AssetStore> {
  const config = await loadConfig(workspace.root).catch(() => undefined);
  if (!config) return AssetStore.open(workspace.paths);
  const deps = await openTakeDeps(workspace.paths, model, config);
  await repairCurrent(deps);
  return deps.store;
}

const listAssetsTool: Tool<{ subject: string }> = {
  name       : 'list_assets',
  description:
    "List the pictures the pipeline has rendered for one subject — character:<id>, location:<id> or scene:<id> — with each one's hash, what it is, its kind, whether it is the take its slot holds now, and whether it is approved. Read-only, and the way to name an asset before `art_notes`, `view_image` or `regenerate_asset`. Concept sketches are listed by `list_images` instead, and a picture the pipeline has not drawn yet has no hash and does not appear here.",
  mutating   : false,
  args: z.object({
    subject: z.string().min(1).describe('character:<id>, location:<id> or scene:<id>'),
  }),
  async run(a, ctx) {
    const subject = parseAssetSubject(a.subject);
    if (!subject) {
      return fail(
        `"${a.subject}" is not a subject — write character:<id>, location:<id> or scene:<id>.`,
      );
    }
    const { model } = await ctx.workspace.load();
    const store = await repairedStore(ctx.workspace, model);
    const assets = store.manifest().filter((asset) => bindsTo(asset, subject));
    if (assets.length === 0) {
      return ok(`No rendered assets for ${a.subject} yet — the pipeline draws them.`);
    }
    const rows = await Promise.all(
      assets.map(async (asset) => {
        const there = await exists(store.pathOf({ hash: asset.hash, ext: asset.ext }));
        const flags = [
          asset.current ? 'current' : '',
          assetApproved(asset, model) ? 'approved' : '',
          there ? '' : 'bytes missing',
        ].filter(Boolean);
        const tail = flags.length ? `  (${flags.join(', ')})` : '';
        return `${asset.hash.slice(0, 12)}  ${assetSlotLabel(asset)}  [${asset.kind}]${tail}`;
      }),
    );
    return ok(`${assets.length} asset(s) for ${a.subject}:\n${rows.join('\n')}`, {
      data: assets.map((asset) => ({
        hash    : asset.hash,
        kind    : asset.kind,
        label   : assetSlotLabel(asset),
        current : asset.current === true,
        approved: assetApproved(asset, model),
      })),
    });
  },
};

const artNotesTool: Tool<{ hash: string }> = {
  name       : 'art_notes',
  description:
    'Show the art-notes rungs that reach one asset and what each says today. Art notes are the one authored field that says how a generated picture should *look*, and they go into the prompt — so a portrait answers with its character rung, a sheet with the character and the outfit, a plate with the location and the variant, and a shot frame with its own rung alone. Read-only: this is the context a proposal needs before `set_art_notes`.',
  mutating   : false,
  args: z.object({ hash: z.string().min(4).describe('an asset hash or prefix from list_assets') }),
  async run(a, ctx) {
    const store = await AssetStore.open(ctx.workspace.paths);
    const found = findAsset(store.manifest(), a.hash);
    if (!found.ok) return fail(found.error);
    const { model } = await ctx.workspace.load();
    const sceneId = found.asset.satisfies[0]?.sceneId;
    const shots = await shotsFor(ctx.workspace, model, sceneId ? [sceneId] : []);
    const rungs = rungsFor(found.asset, { model, shots });
    const label = assetSlotLabel(found.asset);
    if (rungs.length === 0) {
      return ok(`${label} has no art-notes rung — nothing in the project directs how it looks.`);
    }
    const lines = rungs.map(
      (r) => `${r.target}  (${r.label})\n  ${r.notes ?? '(nothing authored)'}`,
    );
    return ok(`Art notes reaching ${label}, widest first:\n${lines.join('\n')}`, { data: rungs });
  },
};

const setArtNotesTool: Tool<{ target: string; notes?: string; mode?: NotesMode }> = {
  name       : 'set_art_notes',
  description:
    'Write the art notes at one rung: character:<id>, character:<id>/<outfit>, location:<id>, location:<id>/<variant>, or shot:<sceneId>/<shotId>. Free text, appended to the prompt the project derives — so this is how a picture is changed, and it re-keys every task that rung reaches, meaning those pictures are re-drawn on the next run. `append` (the default) adds a line to what is there, `replace` overwrites it, `clear` removes it. An outfit, a variant or a shot that does not exist is refused rather than created.',
  mutating   : true,
  args: z.object({
    target: z.string().min(1).describe('the rung, e.g. location:cafe/night'),
    notes : z.string().optional().describe('the text; ignored by mode="clear"'),
    mode  : z.enum(['append', 'replace', 'clear']).optional().describe('default "append"'),
  }),
  async run(a, ctx) {
    // A project whose `project.yaml` will not load still has sheets to write into; neither the
    // title nor the entry reaches an art note.
    const config = await loadConfig(ctx.workspace.root).catch(() => ({ title: 'Untitled' }));
    try {
      const plan = await setArtNotes(
        { config, paths: ctx.workspace.paths },
        { target: a.target, notes: a.notes ?? '', mode: a.mode ?? 'append' },
      );
      const file = rel(ctx.workspace.root, plan.file);
      return ok(
        `${plan.note} Written to ${file}; every picture at that rung is re-drawn on the next run.`,
        { written: [file], data: { target: plan.rung.target, notes: plan.notes, file } },
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

const viewImageTool: Tool<{ hash: string; question?: string }> = {
  name       : 'view_image',
  description:
    'Look at one rendered picture and read a description of it back. Costs a vision call, so ask when the answer changes what you would propose — after a regeneration, or before writing an art note about a picture you have not seen. Takes a hash from `list_assets` or `list_images` and an optional question ("does this read as brutalist yet?"). An asset whose task has not run has no bytes to look at, and this says so rather than describing an older picture.',
  mutating   : false,
  args: z.object({
    hash    : z.string().min(4).describe('an asset hash or prefix'),
    question: z.string().optional().describe('what to ask about it; omitted asks the widest one'),
  }),
  async run(a, ctx) {
    if (!ctx.art) return fail('image tools are not available in this session; nothing was read.');
    const store = await AssetStore.open(ctx.workspace.paths);
    const found = findAsset(store.manifest(), a.hash);
    if (!found.ok) return fail(found.error);
    try {
      const res = await ctx.art.describe({
        hash: found.asset.hash,
        ...(a.question === undefined ? {} : { question: a.question }),
      });
      return ok(`${res.label} (${res.hash.slice(0, 12)}):\n${res.answer}`, { data: res });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
};

const regenerateAssetTool: Tool<{ hash: string; run?: boolean }> = {
  name       : 'regenerate_asset',
  description:
    'Draw one planned picture again: put its task back to pending, and with run=true run the pipeline so it is drawn now. Use it after `set_art_notes`, because a note only reaches a picture that is drawn again. It spends a real image generation and always asks the author first. A concept and an upload are refused by name — nothing planned them, so there is no task to re-run — and with a fixed image seed the same prompt gives back the same picture, so change a note before spending the call.',
  mutating   : true,
  confirm    : true,
  args: z.object({
    hash: z.string().min(4).describe('an asset hash or prefix from list_assets'),
    run : z.boolean().optional().describe('run the pipeline now; omitted only queues the task'),
  }),
  async run(a, ctx) {
    if (!ctx.pipeline) {
      return fail(
        'regenerating a planned asset runs the pipeline, which vnauthor does not do — open the project in the desktop app.',
      );
    }
    const store = await AssetStore.open(ctx.workspace.paths);
    const found = findAsset(store.manifest(), a.hash);
    if (!found.ok) return fail(found.error);
    const queued = await ctx.pipeline.regenerate(found.asset.hash);
    if (!queued.ok) return fail(queued.message);
    if (!a.run) {
      return ok(`${queued.message} Nothing is drawn until the pipeline runs.`, {
        written: queued.written,
        data   : queued,
      });
    }
    const result = await ctx.pipeline.run();
    const failed = result.failed ? `, ${result.failed} failed` : '';
    const gate = result.blockedOnGate ? ' The run is held at the character-approval gate.' : '';
    return ok(`${queued.message} Ran ${result.ran} task(s)${failed}.${gate}`, {
      written: queued.written,
      data   : { ...queued, ...result },
    });
  },
};

/**
 * The triage call. A host with no model for it — a mocked session — answers `null`, and the
 * offline matcher stands in and says in its own `reason` that no model read anything.
 */
async function runTriage(
  approval: ApprovalControl,
  req: { said: readonly string[]; assets: readonly Approvable[] },
  way: ApprovalDirection = 'approve',
): Promise<ApprovalTriage> {
  const backend = await approval.triage();
  return backend ? triageApprovals(backend, req, way) : offlineTriage(req, way);
}

const approveAssetsTool: Tool<Record<string, never>> = {
  name       : 'approve_assets',
  description:
    "Approve the pictures the author asked you to approve. Takes no arguments on purpose: what gets approved is decided by re-reading what the author themselves typed, not by anything you pass in, so there is nothing here to aim. Call it when they ask for artwork to be approved or accepted — 'approve the location art', \"accept Aiko's sheet\", 'approve all of it' — and not otherwise; asking to see a picture or to draw one is not this. A second model reads their recent messages and picks from the list of what is approvable, and the author sees that list and confirms it before anything is written. It refuses, by name, when they did not ask.",
  mutating   : true,
  args       : z.object({}),
  async run(_a, ctx) {
    if (!ctx.approval) {
      return fail(
        'approving art writes the manifest and the character gate, which vnauthor does not do — open the project in the desktop app.',
      );
    }
    if (!ctx.said) {
      return fail('there is no conversation to read, so there is nothing that counts as consent.');
    }
    if (!ctx.confirm) {
      return fail('nobody is here to confirm an approval, so nothing may be approved.');
    }

    const assets = await ctx.approval.list();
    if (assets.length === 0) {
      return ok('Nothing is waiting for approval — every rendered picture is already approved.');
    }
    // What is blocked upstream is shown to the triage model and held back after it, rather than
    // filtered out before: leaving it out would make "approve everything" quietly mean "approve
    // some of it", and the author would read a shorter list with no account of the difference.
    const triage = await runTriage(ctx.approval, { said: ctx.said().slice(-SAID_WINDOW), assets });
    if (!triage.asked) {
      return fail(
        `You did not ask me to approve anything. ${triage.reason} Ask for it in your own words and I will.`,
      );
    }

    const chosen = assets.filter((a) => triage.hashes.includes(a.hash));
    if (chosen.length === 0) {
      return fail(`Nothing waiting for approval matches what you asked for. ${triage.reason}`);
    }
    const held = chosen.filter((a) => a.blocked);
    const ready = chosen.filter((a) => !a.blocked);
    const heldLines = held.map((a) => `  • ${a.label}: ${a.blocked ?? ''}`).join('\n');
    if (ready.length === 0) {
      return fail(`Everything you named is waiting on something upstream:\n${heldLines}`);
    }

    const card =
      approvalCard(triage, ready) +
      (held.length ? `\n\nHeld back, waiting on something upstream:\n${heldLines}` : '');
    if (!(await ctx.confirm(card))) return ok('Nothing approved — you said no.');

    const done: string[] = [];
    const refused: string[] = [];
    // Approved in the order the host listed them, which is upstream first: approving a plate
    // makes the frame drawn from it approvable, so this order lets one call finish a whole chain.
    for (const item of ready) {
      const result = await ctx.approval.approve(item);
      (result.ok ? done : refused).push(`${item.label}: ${result.message}`);
    }
    const part = (what: string, rows: string[]): string =>
      rows.length ? `${what} ${rows.length}:\n${rows.map((r) => `  • ${r}`).join('\n')}` : '';
    return {
      ok     : done.length > 0,
      output : [part('Approved', done), part('Refused', refused)].filter(Boolean).join('\n\n'),
      written: ['vngen/build/manifest.json'],
      data   : { approved: done.length, refused: refused.length },
    };
  },
};

const unapproveAssetsTool: Tool<Record<string, never>> = {
  name       : 'unapprove_assets',
  description:
    "Take approval back off the pictures the author asked you to un-approve. Takes no arguments for the same reason `approve_assets` does not: what is un-approved is decided by re-reading what the author themselves typed. Call it when they ask for approved artwork to be un-approved, un-accepted or rejected — 'un-approve the plate', \"put Aiko's portrait back\", 'none of these are right' is not enough — and not otherwise; disliking a picture or asking for a redraw is not this. A second model reads their recent messages and picks from the list of what is approved, and the author sees that list and confirms it before anything is written. The bytes are never touched, so the same take can be approved again.",
  mutating   : true,
  args       : z.object({}),
  async run(_a, ctx) {
    if (!ctx.approval) {
      return fail(
        'un-approving art writes the manifest and the character gate, which vnauthor does not do — open the project in the desktop app.',
      );
    }
    if (!ctx.said) {
      return fail('there is no conversation to read, so there is nothing that counts as consent.');
    }
    if (!ctx.confirm) {
      return fail('nobody is here to confirm this, so nothing may be un-approved.');
    }

    const assets = await ctx.approval.approved();
    if (assets.length === 0) {
      return ok('Nothing is approved, so there is no approval to take back.');
    }
    const triage = await runTriage(
      ctx.approval,
      { said: ctx.said().slice(-SAID_WINDOW), assets },
      'unapprove',
    );
    if (!triage.asked) {
      return fail(
        `You did not ask me to un-approve anything. ${triage.reason} Ask for it in your own words and I will.`,
      );
    }

    const chosen = assets.filter((a) => triage.hashes.includes(a.hash));
    if (chosen.length === 0) {
      return fail(`Nothing approved matches what you asked for. ${triage.reason}`);
    }
    if (!(await ctx.confirm(unapprovalCard(triage, chosen)))) {
      return ok('Nothing un-approved — you said no.');
    }

    const done: string[] = [];
    const refused: string[] = [];
    // In the order the host listed them, which is downstream first: a frame stops being accepted
    // before the plate it was drawn from does, so nothing is left approved over an unapproved
    // reference partway through.
    for (const item of chosen) {
      const result = await ctx.approval.unapprove(item);
      (result.ok ? done : refused).push(`${item.label}: ${result.message}`);
    }
    const part = (what: string, rows: string[]): string =>
      rows.length ? `${what} ${rows.length}:\n${rows.map((r) => `  • ${r}`).join('\n')}` : '';
    return {
      ok     : done.length > 0,
      output : [part('Un-approved', done), part('Refused', refused)].filter(Boolean).join('\n\n'),
      written: ['vngen/build/manifest.json'],
      data   : { unapproved: done.length, refused: refused.length },
    };
  },
};

export {
  listAssetsTool,
  artNotesTool,
  setArtNotesTool,
  viewImageTool,
  regenerateAssetTool,
  approveAssetsTool,
  unapproveAssetsTool,
};
