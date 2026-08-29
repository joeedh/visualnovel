/**
 * What one prompt edit does to a stored override (`docs/plans/archive/INDEX.md#chunked-prompts` §5, §6).
 *
 * The inputs are the chunks and the current override; the output is the next override, or the
 * sentence refusing the edit. The session owns loading and writing and this file owns the rules, so
 * `check` and `run` cannot disagree and a node test can drive every refusal without a project on
 * disk.
 *
 * An override that ends up saying nothing comes back as `undefined`, which the writers turn into a
 * removed key rather than an empty block. That is what lets an author undo their way back to a
 * sheet that looks untouched.
 */
import { chunkFingerprint, effectiveChunks } from '@vn/artgen';
import {
  promptOverrideIsEmpty,
  type ChunkEdit,
  type ChunkRef,
  type PromptChunk,
  type PromptOverride,
} from '@vn/types';
import { sha256 } from '@vn/util';
import { moveChunk } from '../shared/promptops.js';

/** One authorial act on a prompt. The commands resolve their props into this shape first. */
export type PromptEdit =
  | { op: 'chunk'; chunk: string; how: 'replace' | 'append' | 'mute' | 'clear'; text: string }
  | { op: 'move'; chunk: string; after: string }
  | { op: 'custom'; text: string }
  | { op: 'agent'; text: string; modelId?: string; at?: string }
  | { op: 'clear'; part: 'all' | 'chunks' | 'order' | 'custom' | 'agent' }
  // The caller resolves both the pin and the binding. A slot needs the manifest and the cycle
  // check needs the whole project, so neither belongs in a pure rule.
  | { op: 'addRef'; chunk: string; ref: ChunkRef }
  | { op: 'dropRef'; chunk: string; ref: string }
  | { op: 'repin'; chunk: string; ref: string; to: string; ext: string };

/** The next override, or why there is not one. `undefined` means "store nothing at this rung". */
export type PromptEditResult =
  | { ok: false; reason: string }
  | { ok: true; note: string; override?: PromptOverride };

/** Drop a key from a map, or drop the map when that was its last key. */
function without(
  map: Record<string, ChunkEdit> | undefined,
  key: string,
): Record<string, ChunkEdit> | undefined {
  if (!map || !(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return Object.keys(rest).length ? rest : undefined;
}

/** The override with empty halves removed, or `undefined` when nothing is left to store. */
function settled(o: PromptOverride, note: string): PromptEditResult {
  const next: PromptOverride = { ...o };
  if (!next.mute?.length) delete next.mute;
  if (!next.order?.length) delete next.order;
  if (next.replace && !Object.keys(next.replace).length) delete next.replace;
  if (next.append && !Object.keys(next.append).length) delete next.append;
  if (!next.custom) delete next.custom;
  if (next.refs) {
    // A chunk key with an empty list carries no meaning, and neither does a map of empty lists.
    const kept = Object.entries(next.refs).filter(([, list]) => list.length > 0);
    if (kept.length) next.refs = Object.fromEntries(kept);
    else delete next.refs;
  }
  return promptOverrideIsEmpty(next) ? { ok: true, note } : { ok: true, note, override: next };
}

/** A chunk key as it is written into a refusal or a note. */
function said(chunk: string): string {
  return `"${chunk}"`;
}

/**
 * Apply `edit` to the override stored at a rung. `chunks` is the builders' derivation — the
 * authority on which keys exist, so an edit naming a chunk this prompt does not have is refused
 * with the list rather than written and silently ignored forever.
 */
export function applyPromptEdit(
  chunks: readonly PromptChunk[],
  current: PromptOverride | undefined,
  edit: PromptEdit,
): PromptEditResult {
  const base: PromptOverride = current ? { ...current } : { mode: 'chunks' };
  const known = new Set(chunks.map((c) => c.key));

  switch (edit.op) {
    case 'chunk': {
      if (!known.has(edit.chunk)) {
        return {
          ok: false,
          reason: `No chunk ${said(edit.chunk)} in this prompt. It has: ${[...known].join(', ')}.`,
        };
      }
      const derived = chunks.find((c) => c.key === edit.chunk)!.text;
      const stamped: ChunkEdit = { text: edit.text.trim(), of: sha256(derived) };
      const muted = new Set(base.mute ?? []);

      if (edit.how === 'clear') {
        const had =
          muted.delete(edit.chunk) || !!base.replace?.[edit.chunk] || !!base.append?.[edit.chunk];
        if (!had) return { ok: false, reason: `${said(edit.chunk)} has no override to clear.` };
        return settled(
          {
            ...base,
            mute: [...muted],
            replace: without(base.replace, edit.chunk),
            append: without(base.append, edit.chunk),
          },
          `Restored the derived words of ${said(edit.chunk)}.`,
        );
      }

      if (edit.how === 'mute') {
        if (muted.has(edit.chunk)) {
          return { ok: false, reason: `${said(edit.chunk)} is already muted.` };
        }
        muted.add(edit.chunk);
        return settled({ ...base, mute: [...muted] }, `Muted ${said(edit.chunk)}.`);
      }

      if (!stamped.text) {
        return {
          ok: false,
          reason: `${edit.how === 'replace' ? 'Replacing' : 'Appending to'} a chunk needs text; prompt.setChunk(op=clear) restores the derived words.`,
        };
      }
      const key = edit.how === 'replace' ? 'replace' : 'append';
      return settled(
        { ...base, [key]: { ...base[key], [edit.chunk]: stamped } },
        edit.how === 'replace'
          ? `Replaced ${said(edit.chunk)}.`
          : `Appended to ${said(edit.chunk)}.`,
      );
    }

    case 'move': {
      // Applies the same rule the drag gesture previews, so a drop and a typed command agree to
      // the word.
      const moved = moveChunk(
        {
          chunks: effectiveChunks(chunks, base).map((c) => ({
            key: c.key,
            muted: c.muted,
            text: c.text,
          })),
          ...(base.order ? { order: base.order } : {}),
          mode: base.mode,
        },
        { chunk: edit.chunk, after: edit.after },
      );
      if (!moved.ok) return { ok: false, reason: moved.error };
      return settled({ ...base, order: moved.order }, moved.message);
    }

    case 'custom': {
      const text = edit.text.trim();
      if (!text) {
        return {
          ok: false,
          reason: 'A custom prompt needs text; prompt.clear(part=custom) goes back to the chunks.',
        };
      }
      return settled(
        { ...base, mode: 'custom', custom: text },
        'Wrote a custom prompt; the chunks below are what an agent would be given.',
      );
    }

    case 'agent': {
      // The fingerprint covers the chunks as the override leaves them, so muting one after
      // condensing holds the result rather than sending a prompt the author never saw.
      return settled(
        {
          ...base,
          mode: 'agent',
          agent: {
            text: edit.text,
            of: chunkFingerprint(chunks, base),
            ...(edit.modelId ? { modelId: edit.modelId } : {}),
            ...(edit.at ? { at: edit.at } : {}),
          },
        },
        'Condensed the chunks into one prompt.',
      );
    }

    case 'addRef': {
      if (!known.has(edit.chunk)) {
        return {
          ok: false,
          reason: `No chunk ${said(edit.chunk)} in this prompt. It has: ${[...known].join(', ')}.`,
        };
      }
      const refs = base.refs?.[edit.chunk] ?? [];
      // `refs` is positional and sits inside the task hash, so the same picture twice on one
      // chunk would be a second slot in the list rather than a duplicate that costs nothing.
      if (refs.some((r) => r.pin === edit.ref.pin)) {
        return {
          ok: false,
          reason: `${edit.ref.pin.slice(0, 8)} is already a reference on ${said(edit.chunk)}.`,
        };
      }
      return settled(
        { ...base, refs: { ...base.refs, [edit.chunk]: [...refs, edit.ref] } },
        `Attached ${edit.ref.pin.slice(0, 8)} to ${said(edit.chunk)}.`,
      );
    }

    case 'dropRef': {
      const refs = base.refs?.[edit.chunk];
      if (!refs?.length) {
        return { ok: false, reason: `${said(edit.chunk)} has no reference images on it.` };
      }
      const at = refs.findIndex((r) => r.pin === edit.ref || r.pin.startsWith(edit.ref));
      if (at < 0) {
        return {
          ok: false,
          reason: `No reference "${edit.ref}" on ${said(edit.chunk)}. It has: ${refs
            .map((r) => r.pin.slice(0, 8))
            .join(', ')}.`,
        };
      }
      const gone = refs[at]!;
      return settled(
        { ...base, refs: { ...base.refs, [edit.chunk]: refs.filter((_r, i) => i !== at) } },
        `Removed ${gone.pin.slice(0, 8)} from ${said(edit.chunk)}.`,
      );
    }

    case 'repin': {
      const refs = base.refs?.[edit.chunk];
      if (!refs?.length) {
        return { ok: false, reason: `${said(edit.chunk)} has no reference images on it.` };
      }
      const at = refs.findIndex((r) => r.pin === edit.ref || r.pin.startsWith(edit.ref));
      if (at < 0) {
        return {
          ok: false,
          reason: `No reference "${edit.ref}" on ${said(edit.chunk)}. It has: ${refs
            .map((r) => r.pin.slice(0, 8))
            .join(', ')}.`,
        };
      }
      const ref = refs[at]!;
      if (!ref.from) {
        return {
          ok: false,
          reason: `${ref.pin.slice(0, 8)} is an unlinked reference — it names no slot, so it can never move and there is nothing to repin.`,
        };
      }
      if (ref.pin === edit.to) {
        return { ok: false, reason: `That reference already pins ${edit.to.slice(0, 8)}.` };
      }
      const next = refs.map((r, i) => (i === at ? { ...r, pin: edit.to, ext: edit.ext } : r));
      return settled(
        { ...base, refs: { ...base.refs, [edit.chunk]: next } },
        `Repinned ${said(edit.chunk)}'s reference from ${ref.pin.slice(0, 8)} to ${edit.to.slice(0, 8)}.`,
      );
    }

    case 'clear': {
      if (edit.part === 'all') {
        if (!current) return { ok: false, reason: 'This prompt has no override to clear.' };
        return { ok: true, note: 'Cleared the override; the prompt is the derived chunks again.' };
      }
      const next: PromptOverride = { ...base };
      switch (edit.part) {
        case 'chunks': {
          if (!next.mute?.length && !next.replace && !next.append) {
            return { ok: false, reason: 'No chunk is muted, replaced or appended to.' };
          }
          delete next.mute;
          delete next.replace;
          delete next.append;
          return settled(next, 'Restored every chunk to the words the builders derived.');
        }
        case 'order': {
          if (!next.order?.length) return { ok: false, reason: 'This prompt is in derived order.' };
          delete next.order;
          return settled(next, 'Restored the derived chunk order.');
        }
        case 'custom': {
          if (!next.custom) return { ok: false, reason: 'This prompt has no custom text.' };
          delete next.custom;
          if (next.mode === 'custom') next.mode = 'chunks';
          return settled(next, 'Discarded the custom prompt.');
        }
        case 'agent': {
          if (!next.agent) return { ok: false, reason: 'This prompt has no condensed text.' };
          delete next.agent;
          if (next.mode === 'agent') next.mode = 'chunks';
          return settled(next, 'Discarded the condensed prompt.');
        }
      }
    }
  }
}
