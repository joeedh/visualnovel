/**
 * Registers every `ipcMain.handle`/`ipcMain.on` channel declared in `../shared/ipc.ts`. Purely
 * declarative: each handler delegates to `getSession(ctx)`, `getStack(ctx)`, or a pending form.
 */
import { BrowserWindow, ipcMain } from 'electron';
import type { AppContext } from './context.js';
import { getSession } from './sessionaccess.js';
import { getStack, withVersions } from './stack.js';
import { catalogOf } from '../commands/catalog-entry.js';
import { notifications } from '../notify/notifications.js';
import { APPROVAL_ORDER_KEY } from '../../shared/sessionkeys.js';
import type { InvokeChannel, InvokeChannels } from '../../shared/ipc.js';
import type { WindowId } from './windows.js';

/**
 * Register against the channel map, so a handler can't drift from its declared signature.
 *
 * `origin` is which window asked — `undefined` for a sender that is not one of ours. Every
 * `view.*` effect used to be broadcast-by-accident: there was one listener, so "the window that
 * asked" and "the window there is" were the same window.
 */
function handle<C extends InvokeChannel>(
  ctx: AppContext,
  channel: C,
  fn: (
    origin: WindowId | undefined,
    ...args: Parameters<InvokeChannels[C]>
  ) => ReturnType<InvokeChannels[C]> | Promise<ReturnType<InvokeChannels[C]>>,
): void {
  ipcMain.handle(channel, (event, ...args) =>
    fn(
      ctx.windows.byHandle(BrowserWindow.fromWebContents(event.sender)),
      ...(args as Parameters<InvokeChannels[C]>),
    ),
  );
}

export function registerIpc(ctx: AppContext): void {
  handle(ctx, 'workspace:index', () => getSession(ctx).index());
  handle(ctx, 'workspace:doctree', () => getSession(ctx).docTree());
  handle(ctx, 'workspace:filetree', () => getSession(ctx).fileTree());
  handle(ctx, 'workspace:skilltree', () => getSession(ctx).skillTree());
  handle(ctx, 'workspace:skills', () => getSession(ctx).skillEntries());
  handle(ctx, 'agent:run', (origin, input) => {
    // Remembered so a plan or a clarifying question lands where the turn was started.
    ctx.turnWindow = origin;
    return getSession(ctx).runAgent(input);
  });
  handle(ctx, 'agent:setMode', (_origin, mode) => getSession(ctx).setMode(mode));
  handle(ctx, 'agent:setModel', (_origin, modelId) => getSession(ctx).setModel(modelId));
  handle(ctx, 'agent:clear', () => getSession(ctx).clearAgent());
  handle(ctx, 'agent:system', () => getSession(ctx).systemPrompt());
  handle(ctx, 'plan:decision', (_origin, payload) =>
    ctx.pendingPlans.answer(payload.id, payload.decision),
  );
  handle(ctx, 'ask:answer', (_origin, payload) =>
    ctx.pendingAsks.answer(payload.id, payload.answers),
  );
  handle(ctx, 'confirm:decision', (_origin, payload) =>
    ctx.pendingConfirms.answer(payload.id, payload.allowed),
  );
  handle(ctx, 'pipeline:status', () => getSession(ctx).status());
  handle(ctx, 'pipeline:run', (_origin, opts) => getSession(ctx).runPipeline(opts.mock));
  handle(ctx, 'gate:candidates', (_origin, characterId) =>
    getSession(ctx).gateCandidates(characterId),
  );
  handle(ctx, 'gate:approve', (_origin, payload) =>
    getSession(ctx).approveCharacter(payload.characterId, payload.hash),
  );
  handle(ctx, 'story:play', () => getSession(ctx).playable());
  handle(ctx, 'story:graph', () => getSession(ctx).storyGraph());
  handle(ctx, 'story:coverage', (_origin, sceneId) => getSession(ctx).sceneCoverage(sceneId));
  handle(ctx, 'gengraph:doc', (_origin, slug) => getSession(ctx).graphDoc(slug));
  handle(ctx, 'gengraph:group', (_origin, ref) => getSession(ctx).groupDoc(ref));

  // `catalogOf`, not a second `toCatalog` call: the two drifted, and the channel served a
  // catalog with no interactions while `commands.json` listed five.
  handle(ctx, 'command:catalog', () => catalogOf(ctx.registry));
  handle(ctx, 'command:exec', async (origin, request) => {
    const source = request.source ?? 'ui';
    if (request.dsl !== undefined) {
      return withVersions(
        await getStack(ctx).execDsl(request.dsl, source, origin, request.checkpoint),
      );
    }
    if (request.id === undefined) {
      return { ok: false as const, error: 'command:exec needs an id or a dsl' };
    }
    return withVersions(
      await getStack(ctx).exec(request.id, request.props ?? {}, source, origin, request.checkpoint),
    );
  });
  handle(ctx, 'command:check', (origin, request) =>
    getStack(ctx).check(request.id, request.props ?? {}, origin),
  );
  handle(ctx, 'command:history', (_origin, limit) => getStack(ctx).history(limit));
  handle(ctx, 'command:undo', () => getStack(ctx).undo());
  handle(ctx, 'command:redo', () => getStack(ctx).redo());
  handle(ctx, 'command:checkpointBegin', (_origin, { shortLabel, message, scope }) =>
    getStack(ctx).beginCheckpoint(shortLabel, message, scope),
  );
  handle(ctx, 'command:checkpointEnd', (_origin, checkpoint) =>
    getStack(ctx).endCheckpoint(checkpoint),
  );

  handle(ctx, 'notify:list', () => notifications().list());
  handle(ctx, 'notify:post', (_origin, input) => notifications().post(input));

  // The read is also what remembers the order: a hash the stored order has not seen is new since
  // the list was last drawn, and stays on top until something reads past it.
  handle(ctx, 'approval:list', async () => {
    const previous = ctx.getSessionState().get<string[]>(APPROVAL_ORDER_KEY, []);
    const { items, order } = await getSession(ctx).approvalQueue(previous);
    ctx.getSessionState().set(APPROVAL_ORDER_KEY, order);
    return items;
  });

  handle(ctx, 'session:set', (_origin, payload) =>
    ctx.getSessionState().set(payload.key, payload.value, payload.scope),
  );
  // Synchronous on purpose (so the preload can hand the renderer its state before first paint)
  // and therefore registered directly: `handle` above is `ipcMain.handle`-only.
  ipcMain.on('session:snapshot:sync', (event) => {
    event.returnValue = ctx.getSessionState().snapshot();
  });
}
