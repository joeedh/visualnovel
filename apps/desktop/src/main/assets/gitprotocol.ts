/**
 * Serves a file as it was at a commit to the renderer over `vngit://`, for the History pane's
 * picture diffs. Two spellings: `vngit://<role>/<blobId>.<ext>` names a blob by the id
 * `git.changes` reports, and `vngit://<role>/<sha>/<path>` names a path at a commit, which is
 * what `git.blob` answers for a path a save did not touch.
 */
import { protocol } from 'electron';
import { parseGitUrl } from '../../shared/history.js';
import type { AppContext } from '../runtime/context.js';
import { assetType } from './assetprotocol.js';

/** A commit's bytes never change, so the renderer may hold them for as long as it likes. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function registerGitProtocol(ctx: AppContext): void {
  protocol.handle('vngit', async (request) => {
    const ask = parseGitUrl(request.url);
    // Read per request rather than captured, so a switched workspace serves its own history
    const session = ctx.session;
    if (!ask || !session) return new Response(null, { status: 404 });
    const bytes = await session.gitBytes(ask.role, ask.ref, ask.path).catch(() => null);
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(bytes, {
      headers: { 'content-type': assetType(ask.ext), 'cache-control': IMMUTABLE },
    });
  });
}
