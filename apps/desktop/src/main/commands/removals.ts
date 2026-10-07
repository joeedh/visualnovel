/**
 * The question a command asks before it removes files in a project the app does not commit: one
 * that is not its own repository's root, or is in none. There, undo is the only way back, and undo
 * history ends when the app closes. Where the app commits, the commit is the way back, so nothing
 * is asked.
 */
import type { CommandContext } from '@vn/commands';
import { ownsRepo } from '../workspace/workspace.js';
import type { CommandHost } from './host.js';

/**
 * Returns the sentence `confirmWhen` asks, or undefined when the app commits this project or
 * nothing would be removed. `removes` lists what the run would remove, and is called only after
 * the commit check.
 */
export async function askBeforeRemoving(
  ctx: CommandContext<CommandHost>,
  removes: () => Promise<readonly string[]>,
): Promise<string | undefined> {
  if (await ownsRepo(ctx.root)) return undefined;
  const gone = await removes();
  if (gone.length === 0) return undefined;
  const shown =
    gone.length > 3
      ? `${gone.slice(0, 3).join(', ')} and ${gone.length - 3} more`
      : gone.join(', ');
  return (
    `The app does not commit this project, so removing ${shown} can be undone only until the ` +
    'app closes.'
  );
}
