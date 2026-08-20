/**
 * What the confirm card says. The agent's gate hands over a tool name and its raw arguments;
 * a card that printed those would read like a stack frame, and the author is being asked to
 * spend money or rewrite history — so main turns them into one English sentence here.
 *
 * Pure, and the desktop jest project is node-only, so this is where the wording is pinned.
 */

/** Read one string field out of unknown tool args without trusting the shape. */
function field(args: unknown, key: string): string {
  if (typeof args !== 'object' || args === null) return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** Fit a quoted fragment on one line; the card is a sentence, not the argument list. */
function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The sentence for one always-confirm tool. An unknown tool still gets a sentence rather than a
 * blank, so a new confirm-gated tool is never easier to allow than the ones named here.
 */
export function confirmDetail(tool: string, args: unknown): string {
  switch (tool) {
    case 'generate_image': {
      const sentence = clip(field(args, 'sentence'));
      const subject = field(args, 'subject');
      const of = subject ? ` It binds to ${subject}.` : '';
      return `Draw a concept sketch: “${sentence}”.${of} Costs one image generation.`;
    }
    case 'edit_image': {
      const hash = field(args, 'hash').slice(0, 12);
      const prompt = field(args, 'prompt');
      const how = prompt ? `from an edited prompt: “${clip(prompt)}”` : 'from the same prompt';
      return `Redraw concept ${hash} ${how}. Costs one image generation; the original stays.`;
    }
    case 'regenerate_asset': {
      const hash = field(args, 'hash').slice(0, 12);
      const runs =
        typeof args === 'object' && args !== null && (args as Record<string, unknown>)['run'];
      return runs === true
        ? `Re-render asset ${hash} now. Costs one image generation.`
        : `Queue asset ${hash} to be re-rendered by the next pipeline run.`;
    }
    case 'git_revert': {
      const ref = field(args, 'ref') || field(args, 'sha') || 'the last commit';
      return `Revert ${ref}, undoing everything that commit changed.`;
    }
    case 'git_restore': {
      const path = field(args, 'path') || field(args, 'paths') || 'the whole worktree';
      return `Discard uncommitted changes to ${path}. This cannot be undone.`;
    }
    case 'run_skill': {
      // The loop routes a skill's own confirm through here as `{ message }`, already a sentence.
      const message = field(args, 'message');
      return message || `Run the skill ${field(args, 'name') || '(unnamed)'}, which runs a script.`;
    }
    default: {
      const shown = args === undefined ? '' : clip(JSON.stringify(args) ?? '');
      return shown ? `Run ${tool} with ${shown}.` : `Run ${tool}.`;
    }
  }
}
