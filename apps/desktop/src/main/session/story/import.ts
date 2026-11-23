import { loadConfig, setStartScene } from '@vn/config';
import { rename } from 'node:fs/promises';
import { sceneChunksFromScript, type SceneChunk } from '@vn/model';
import { parseFountain } from '@vn/parse';
import { ProjectPaths, findScreenplay, readSceneChunks, writeSceneChunk } from '@vn/store';
import { exists, readText } from '@vn/util';
import type { WorkspaceSession } from '../core.js';
import { relPath } from '../load/tree.js';

/**
 * The migration `workspace.import` would perform, decided and not written: the chunks
 * `sceneChunksFromScript` proved read back as the same scenes, plus the screenplay to move
 * aside. Shared with `previewImport`, so a refused check reports the same message the run
 * would.
 */
async function planImport(session: WorkspaceSession): Promise<{
  ok: boolean;
  message: string;
  chunks: SceneChunk[];
  entry: string | undefined;
  scriptPath: string | undefined;
}> {
  const paths = new ProjectPaths(session.dir);
  const fail = (message: string) => ({
    ok: false,
    message,
    chunks    : [],
    entry     : undefined,
    scriptPath: undefined,
  });

  // An existing chunk is either a previous import or hand-authored work, and importing over
  // the second is the loss this refusal exists to prevent.
  const already = await readSceneChunks(paths);
  if (already.length > 0) {
    return fail(`scenes/ already holds ${already.length} chunk(s); importing would overwrite.`);
  }
  // Uses the same finder the loader uses to report a leftover screenplay, so the file this
  // converts is the file that warning names — not a second opinion about which one it is.
  const scriptPath = await findScreenplay(paths);
  if (scriptPath === undefined) {
    return fail('There is no screenplay/*.fountain to import.');
  }
  const aside = `${scriptPath}.imported`;
  if (await exists(aside)) return fail(`${relPath(session.dir, aside)} already exists.`);

  const config = await loadConfig(session.dir);
  const result = sceneChunksFromScript(
    parseFountain(await readText(scriptPath)),
    config.start === undefined ? {} : { start: config.start },
  );
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) return fail(errors.map((d) => d.message).join(' '));

  const warnings = result.diagnostics.length ? ` ${result.diagnostics.length} warning(s).` : '';
  return {
    ok     : true,
    message: `${result.chunks.length} scene(s) would move into scenes/.${warnings}`,
    chunks : result.chunks,
    entry  : result.entry,
    scriptPath,
  };
}

/** What `importScreenplay` would do, without doing it. */
export async function previewImport(
  session: WorkspaceSession,
): Promise<{ ok: boolean; message: string }> {
  const { ok, message } = await planImport(session);
  return { ok, message };
}

/**
 * Convert a `screenplay/*.fountain` project into one chunk per scene — the `vngen import`
 * equivalent. The screenplay is moved aside rather than deleted, and moved last: while it is
 * still a `.fountain` the project reports it on every load, so the rename finishes the import.
 */
export async function importScreenplay(
  session: WorkspaceSession,
): Promise<{ ok: boolean; message: string; written: string[] }> {
  const plan = await planImport(session);
  if (!plan.ok || plan.scriptPath === undefined) {
    return { ok: false, message: plan.message, written: [] };
  }

  const paths = new ProjectPaths(session.dir);
  const written: string[] = [];
  for (const chunk of plan.chunks) {
    await writeSceneChunk(paths, chunk.id, chunk.doc);
    written.push(relPath(session.dir, paths.sceneFile(chunk.id)));
  }
  // A directory has no document order, so the entry the screenplay implied is written down.
  if (plan.entry !== undefined && (await setStartScene(session.dir, plan.entry))) {
    written.push(relPath(session.dir, paths.projectConfig));
  }
  const aside = `${plan.scriptPath}.imported`;
  await rename(plan.scriptPath, aside);
  written.push(relPath(session.dir, aside));

  return {
    ok     : true,
    message:
      `Imported ${plan.chunks.length} scene(s) into scenes/; the screenplay is now ` +
      `${relPath(session.dir, aside)} — delete it once you are satisfied.`,
    written,
  };
}
