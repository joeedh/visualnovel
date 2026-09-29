/**
 * How main runs one `command:exec` request. Kept apart from `ipc.ts`, which imports `electron`,
 * so the rule can be tested without it.
 */
import type { ExecOptions } from '@vn/commands';
import type { CommandExecRequest } from '../../shared/ipc.js';
import type { WindowId } from './windows.js';

/**
 * Builds the exec options for one request. A CDP call counts as already confirmed, since a
 * script has nobody to ask and the anchor sweep and guided tours run through CDP.
 */
export function execOptions(
  origin: WindowId | undefined,
  request: CommandExecRequest,
): ExecOptions {
  return {
    ...(origin === undefined ? {} : { origin }),
    ...(request.checkpoint ? { checkpoint: request.checkpoint } : {}),
    confirmed: request.confirmed === true || request.source === 'cdp',
  };
}
