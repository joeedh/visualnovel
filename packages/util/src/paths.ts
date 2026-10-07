/** Comparing two spellings of one filesystem path. */
import { posix, win32 } from 'node:path';

/**
 * Whether `a` and `b` name the same location, after resolving each. On win32 the comparison
 * ignores case and the slash direction, as the filesystem does, so `c:/story` and `C:\Story`
 * agree; git prints a root with the drive letter upper-cased whatever the caller typed.
 */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  if (platform !== 'win32') return posix.resolve(a) === posix.resolve(b);
  return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();
}
