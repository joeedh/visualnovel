import type { Choice, Scene } from '@vn/types';
import { parseBranchMarker, type FountainScript } from '@vn/parse';
import { slug } from './slug.js';

/** A location reference mined from a scene heading (report §P1 deterministic baseline). */
export interface MinedLocation {
  id: string;
  name: string;
  variant: string;
}

/** Parse `INT. CLASSROOM - AFTERNOON` into a location id/name + time-of-day variant. */
export function parseHeading(heading: string): MinedLocation {
  const withoutPrefix = heading.replace(/^(int\.?\/ext\.?|int\.?|ext\.?|est\.?|i\/e)[ .]+/i, '');
  const parts = withoutPrefix.split(/\s+-\s+/);
  const name = (parts[0] ?? withoutPrefix).trim();
  const variant = parts.length > 1 ? slug(parts.slice(1).join(' ')) : 'day';
  return { id: slug(name), name: name.replace(/\s+/g, ' ').trim(), variant: variant || 'day' };
}

/**
 * Split a Fountain script into scene graph nodes (report §6, §P5.1). Each scene heading
 * starts a node; branch markers inside the node supply its id, choices, and linear
 * `next`. The narrative body is retained for the later (generative) shot decomposition.
 */
export function splitScenes(script: FountainScript): { scenes: Scene[]; mined: MinedLocation[] } {
  const scenes: Scene[] = [];
  const mined: MinedLocation[] = [];
  let current: Scene | null = null;
  let pendingSynopsis: string | undefined;
  const bodyLines: string[] = [];
  const cueNames = new Set<string>();
  const sceneIdOverrides = new Map<Scene, string>();

  const flush = (): void => {
    if (current) {
      current.body = bodyLines.join('\n').trim();
      current.characters = [...cueNames];
      scenes.push(current);
    }
    bodyLines.length = 0;
    cueNames.clear();
  };

  let index = 0;
  for (const el of script.elements) {
    switch (el.type) {
      case 'scene_heading': {
        flush();
        const loc = parseHeading(el.text);
        mined.push(loc);
        index += 1;
        current = {
          id: el.sceneNumber ? slug(el.sceneNumber) : `${loc.id}_${index}`,
          location: loc.id,
          characters: [],
          synopsis: pendingSynopsis,
          body: '',
          choices: [],
          next: undefined,
          shots: [],
        };
        // Stash the heading's intended variant on the scene via the first mined entry.
        current.location = loc.id;
        pendingSynopsis = undefined;
        break;
      }
      case 'synopsis':
        if (current) current.synopsis = el.text;
        else pendingSynopsis = el.text;
        break;
      case 'note': {
        const marker = parseBranchMarker(el.text);
        if (!marker || !current) break;
        if (marker.kind === 'scene') sceneIdOverrides.set(current, marker.id);
        else if (marker.kind === 'choice')
          current.choices.push({ label: marker.label, goto: marker.goto } satisfies Choice);
        else if (marker.kind === 'next') current.next = marker.goto;
        break;
      }
      case 'character':
        cueNames.add(el.name);
        if (current) bodyLines.push(`${el.name}:`);
        break;
      case 'dialogue':
      case 'action':
      case 'parenthetical':
        if (current) bodyLines.push(el.text);
        break;
      default:
        break;
    }
  }
  flush();

  // Apply [[scene: id]] overrides after splitting so ids are stable.
  for (const scene of scenes) {
    const override = sceneIdOverrides.get(scene);
    if (override) scene.id = override;
  }

  return { scenes, mined };
}
