/**
 * P1 location breakdown (report §P1). The deterministic baseline (scene-heading mining) already
 * populated `model.locations`; this step enriches a location with a short, authored-looking
 * breakdown markdown used both as human-editable `work/` output and as grounding for the P2
 * reference prompts. With a mock or echo text provider (or when no enrichment is requested) it
 * emits a deterministic breakdown, so the pipeline runs end-to-end without burning API calls.
 */
import type { Location, Providers } from '@vn/types';
import { minedLocationsSchema } from '@vn/types';

/** The breakdown markdown derived from a location as it stands, with no provider call. */
export function deterministicBreakdown(location: Location): string {
  const variants = location.variants.map(
    (v) => `- ${v.id}${v.description ? `: ${v.description}` : ''}`,
  );
  return [
    `# ${location.name}`,
    '',
    location.description || '_No authored description; mined from the screenplay._',
    '',
    location.mood ? `**Mood:** ${location.mood}` : '',
    location.lighting ? `**Lighting:** ${location.lighting}` : '',
    location.palette.length ? `**Palette:** ${location.palette.join(', ')}` : '',
    '',
    '## Variants',
    ...(variants.length ? variants : ['- day']),
    '',
  ]
    .filter((line) => line !== '')
    .join('\n')
    .concat('\n');
}

const MINE_SYSTEM = [
  'You enrich location descriptions for a visual-novel art bible.',
  'Given a location id, name, and any existing notes, return JSON of the form',
  '{"locations":[{"id","name","aliases":[],"description","variants":[]}]} with a single',
  'entry: a vivid 1-2 sentence visual description and a sensible list of time-of-day /',
  'weather variants. Respond with JSON only.',
].join(' ');

/**
 * Optionally use the text LLM to flesh out a sparse (mined) location's description and
 * variants. Returns the original location untouched on any failure — enrichment is
 * best-effort and never blocks the pipeline.
 */
export async function enrichLocation(location: Location, providers: Providers): Promise<Location> {
  if (location.description.trim()) return location;
  const prompt = [
    `Location id: ${location.id}`,
    `Name: ${location.name}`,
    `Known variants: ${location.variants.map((v) => v.id).join(', ') || 'day'}`,
  ].join('\n');
  try {
    const result = await providers.text.structured(
      prompt,
      (raw) => minedLocationsSchema.parse(JSON.parse(raw)),
      MINE_SYSTEM,
    );
    const mined = result.locations[0];
    if (!mined) return location;
    const have = new Set(location.variants.map((v) => v.id));
    const variants = [...location.variants];
    for (const v of mined.variants) if (!have.has(v)) variants.push({ id: v, description: '' });
    return { ...location, description: mined.description || location.description, variants };
  } catch {
    return location;
  }
}
