import { stringify as stringifyYaml } from 'yaml';
import { ENTITY_TAG_KEY, ENTITY_TAGS, type Character } from '@vn/types';
import { stringifyFrontMatter } from '@vn/parse';

/**
 * Writes this sheet at `wiki/<wiki>.md` with its tag instead of in its conventional directory,
 * which is how a fixture exercises discovery by tag. The filename stem still has to agree
 * with `id`.
 */
interface WikiPlacement {
  wiki?: string;
}

/** Overrides for a generated character sheet. Only `id` is required. */
export interface CharacterSpec extends WikiPlacement {
  id: string;
  name?: string;
  status?: Character['status'];
  defaultOutfit?: string;
  /**
   * The wardrobe, outfit id → description. Omitted by default, which is the sheet every project
   * had before outfits were authorable: `characterFromDoc` synthesizes the default alone.
   */
  outfits?: Record<string, string>;
  traits?: string[];
  palette?: string[];
  approvedPortrait?: string;
  /** Markdown body — the canonical description. */
  description?: string;
}

/** Overrides for a generated set-location sheet. Only `id` is required. */
export interface LocationSpec extends WikiPlacement {
  id: string;
  name?: string;
  mood?: string;
  lighting?: string;
  palette?: string[];
  variants?: string[];
  /** Markdown body — the canonical description. */
  description?: string;
}

/** `aiko` → `Aiko`, `loc_1` → `Loc 1`. The inverse of `@vn/model`'s `slug` for fixture ids. */
export function titleCase(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Widen a bare id into a full spec, leaving an already-specified one alone. */
export function toSpec<T extends { id: string }>(value: string | T): T {
  return typeof value === 'string' ? ({ id: value } as T) : value;
}

/** Render a character sheet for a spec, filling in fixture defaults. */
export function characterDoc(spec: CharacterSpec): string {
  const name = spec.name ?? titleCase(spec.id);
  const data: Record<string, unknown> = {
    id: spec.id,
    // Only a wiki sheet states its kind; a conventional one carries the tag from its directory,
    // so writing it there too would test a spelling the fixture never has to use.
    ...(spec.wiki ? { [ENTITY_TAG_KEY]: ENTITY_TAGS.character } : {}),
    name,
    status        : spec.status ?? 'draft',
    default_outfit: spec.defaultOutfit ?? 'uniform',
    ...(spec.outfits ? { outfits: spec.outfits } : {}),
    palette: spec.palette ?? ['#a02828', '#e8c8b0'],
    traits : spec.traits ?? ['curious', 'soft-spoken'],
  };
  if (spec.approvedPortrait) data['approved_portrait'] = spec.approvedPortrait;
  return stringifyFrontMatter(data, `${spec.description ?? `${name}, a fixture character.`}\n`);
}

/** Render a set-location sheet for a spec, filling in fixture defaults. */
export function locationDoc(spec: LocationSpec): string {
  const name = spec.name ?? titleCase(spec.id);
  const data: Record<string, unknown> = {
    id: spec.id,
    ...(spec.wiki ? { [ENTITY_TAG_KEY]: ENTITY_TAGS.location } : {}),
    name,
    mood    : spec.mood ?? 'quiet',
    lighting: spec.lighting ?? 'flat afternoon light',
    palette : spec.palette ?? ['#d8c19a', '#8aa6c1'],
    variants: spec.variants ?? ['day'],
  };
  return stringifyFrontMatter(data, `${spec.description ?? `${name}, a fixture location.`}\n`);
}

/** Render `project.yaml` from a config object (already merged with the caller's overrides). */
export function projectYaml(config: Record<string, unknown>): string {
  return stringifyYaml(config);
}
