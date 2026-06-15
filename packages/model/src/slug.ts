/** Deterministic id slug: lowercase, non-alphanumerics collapsed to underscores. */
export function slug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}
