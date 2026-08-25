/**
 * How a slot is written down: the address a walk keys by, the address an author types, and the
 * name a refusal uses. Nothing here reaches the filesystem or any other package's runtime, which
 * is why it is a second entry point rather than part of the barrel. `@vn/gengraph` validates an
 * output node's slot against this vocabulary and is imported by the desktop renderer, where a
 * `node:` module anywhere in the import graph fails the bundle rather than the typecheck.
 */
import type { RefBinding } from '@vn/types';

/**
 * One slot, as a string, so a walk can use a `Set`. Angles stay distinct, because two angles of
 * one outfit are two different pictures.
 *
 * It doubles as the address an author types (`prompt.addRef(ref=plate:cafe/night)`), which is
 * why {@link parseSlot} is written directly against it: one spelling, and a round-trip test.
 */
export function slotKey(b: RefBinding): string {
  switch (b.kind) {
    case 'portrait':
      return `portrait:${b.characterId}`;
    case 'sheet':
      return `sheet:${b.characterId}/${b.outfit}/${b.angle}`;
    case 'plate':
      return `plate:${b.locationId}/${b.variant}`;
    case 'shot':
      return `shot:${b.sceneId}/${b.shotId}`;
    case 'asset':
      return `asset:${b.hash}`;
  }
}

/** What a slot is called in a refusal. Ids rather than display names — this names a path, not art. */
export function slotLabel(b: RefBinding): string {
  switch (b.kind) {
    case 'portrait':
      return `${b.characterId} portrait`;
    case 'sheet':
      return `${b.characterId}/${b.outfit} ${b.angle} sheet`;
    case 'plate':
      return `${b.locationId} — ${b.variant} plate`;
    case 'shot':
      return `${b.sceneId}/${b.shotId} frame`;
    case 'asset':
      return `asset ${b.hash.slice(0, 8)}`;
  }
}

/**
 * A slot address back into a binding — the inverse of {@link slotKey}, and the way a command names
 * one. A bare hex string is an `asset` binding: an upload or a concept is its own identity, so
 * pinning it names no slot and can never drift.
 */
export function parseSlot(text: string): RefBinding | undefined {
  const said = text.trim();
  if (!said) return undefined;
  if (/^[0-9a-f]{8,64}$/i.test(said)) return { kind: 'asset', hash: said.toLowerCase() };

  const cut = said.indexOf(':');
  if (cut < 0) return undefined;
  const parts = said.slice(cut + 1).split('/');
  const [a, b, c] = parts;
  switch (said.slice(0, cut)) {
    case 'portrait':
      return parts.length === 1 && a ? { kind: 'portrait', characterId: a } : undefined;
    case 'sheet':
      return parts.length === 3 && a && b && c
        ? { kind: 'sheet', characterId: a, outfit: b, angle: c }
        : undefined;
    case 'plate':
      return parts.length === 2 && a && b
        ? { kind: 'plate', locationId: a, variant: b }
        : undefined;
    case 'shot':
      return parts.length === 2 && a && b ? { kind: 'shot', sceneId: a, shotId: b } : undefined;
    case 'asset':
      return parts.length === 1 && a ? { kind: 'asset', hash: a } : undefined;
    default:
      return undefined;
  }
}
