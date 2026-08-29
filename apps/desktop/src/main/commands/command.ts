/**
 * A command that reports whether another invocation would run.
 *
 * It takes a DSL line rather than an id and a prop bag because the answer depends on the exact
 * arguments — `story.setNext(scene='a' goto='b')` refuses where `goto='c'` accepts — and the DSL
 * is already how an invocation is written down everywhere else (history, the palette, CDP).
 */
import { defineFor, parseCommand, prop } from '@vn/commands';
import type { CommandHost } from './host.js';

const define = defineFor<CommandHost>();

export const commandCheck = define({
  id: 'command.check',
  title: 'Check a command',
  description:
    'Ask whether an invocation would run, without running it. Answers accept, refuse (with the ' +
    'reason the command itself would give), or undeclared for a command with no precondition.',
  notes:
    'Would that invocation run? See [Preconditions](command-system.md#preconditions-asking-before-acting).',
  mutating: false,
  props: { invocation: prop.string("the invocation to check, e.g. story.setNext(scene='a')") },
  async run({ invocation }, ctx) {
    const parsed = parseCommand(invocation);
    const result = await ctx.host.check(parsed.id, parsed.props);
    return { message: `${parsed.id}: ${result.state} — ${result.message}`, data: result };
  },
});
