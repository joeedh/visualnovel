/** True for a name that can be a graph's or a group's file name, which is what makes it addressable. */
export function isGraphSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(slug);
}
