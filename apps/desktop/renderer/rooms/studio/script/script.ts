/**
 * The script editor's pure half. Nothing here reads the DOM or calls a command — the surface
 * asks it what a gesture means and then runs the command it names, so the mapping from an
 * authorial act to a `CommandRecord` is testable in node.
 */

/**
 * The local part of a `${sceneId}:L<n>` id, which is what the gutter shows. The scene half is
 * already the column's heading, and repeating it on every row makes the numbers unreadable.
 */
export function localLineId(lineId: string): string {
  const colon = lineId.lastIndexOf(':');
  return colon < 0 ? lineId : lineId.slice(colon + 1);
}
