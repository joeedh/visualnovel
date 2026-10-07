/**
 * Dropping reference pins from a prompt override, the part of an entity delete that reaches every
 * override rung. `prompt.dropRef`'s rule (`applyPromptEdit`) lives in the desktop app and drops one
 * pin by position; this drops every pin a predicate matches, so `vnauthor` can run it too.
 */
import { promptOverrideIsEmpty, type ChunkRef, type PromptOverride } from '@vn/types';

/** An override with some pins removed, and how many went. */
export interface PinsDropped {
  /** Absent when nothing else was left in it. */
  override: PromptOverride | undefined;
  dropped: number;
}

/**
 * Removes every reference `drops` matches from `override`. A chunk left with no references loses
 * its key, and an override left with nothing in it becomes absent, so a writer clears the key
 * rather than leaving an empty block on the sheet.
 */
export function dropPins(
  override: PromptOverride | undefined,
  drops: (ref: ChunkRef) => boolean,
): PinsDropped {
  if (!override?.refs) return { override, dropped: 0 };
  let dropped = 0;
  const refs: Record<string, ChunkRef[]> = {};
  for (const [key, list] of Object.entries(override.refs)) {
    const kept = list.filter((ref) => !drops(ref));
    dropped += list.length - kept.length;
    if (kept.length > 0) refs[key] = kept;
  }
  if (dropped === 0) return { override, dropped };
  const { refs: _old, ...rest } = override;
  const next: PromptOverride = Object.keys(refs).length > 0 ? { ...rest, refs } : rest;
  return { override: promptOverrideIsEmpty(next) ? undefined : next, dropped };
}
