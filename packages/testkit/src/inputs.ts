import { stringify as stringifyYaml } from 'yaml';
import type { Character } from '@vn/types';
import { stringifyFrontMatter } from '@vn/parse';

/** Overrides for a generated `characters/<id>/character.md`. Only `id` is required. */
export interface CharacterSpec {
  id: string;
  name?: string;
  status?: Character['status'];
  defaultOutfit?: string;
  traits?: string[];
  palette?: string[];
  referenceImages?: string[];
  approvedPortrait?: string;
  /** Markdown body — the canonical description. */
  description?: string;
}

/** Overrides for a generated `locations/<id>.md`. Only `id` is required. */
export interface LocationSpec {
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

/** Render `characters/<id>/character.md` for a spec, filling in fixture defaults. */
export function characterDoc(spec: CharacterSpec): string {
  const name = spec.name ?? titleCase(spec.id);
  const data: Record<string, unknown> = {
    id: spec.id,
    name,
    status: spec.status ?? 'draft',
    default_outfit: spec.defaultOutfit ?? 'uniform',
    palette: spec.palette ?? ['#a02828', '#e8c8b0'],
    traits: spec.traits ?? ['curious', 'soft-spoken'],
    reference_images: spec.referenceImages ?? [],
  };
  if (spec.approvedPortrait) data['approved_portrait'] = spec.approvedPortrait;
  return stringifyFrontMatter(data, `${spec.description ?? `${name}, a fixture character.`}\n`);
}

/** Render `locations/<id>.md` for a spec, filling in fixture defaults. */
export function locationDoc(spec: LocationSpec): string {
  const name = spec.name ?? titleCase(spec.id);
  const data: Record<string, unknown> = {
    id: spec.id,
    name,
    mood: spec.mood ?? 'quiet',
    lighting: spec.lighting ?? 'flat afternoon light',
    palette: spec.palette ?? ['#d8c19a', '#8aa6c1'],
    variants: spec.variants ?? ['day'],
  };
  return stringifyFrontMatter(data, `${spec.description ?? `${name}, a fixture location.`}\n`);
}

/** Render `project.yaml` from a config object (already merged with the caller's overrides). */
export function projectYaml(config: Record<string, unknown>): string {
  return stringifyYaml(config);
}
