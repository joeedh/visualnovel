/** Read-only renderer diagnostics, retained in memory so measuring edits adds no file writes. */
import { TimingBuffer } from '@vn/commands';

export const pageTimings = new TimingBuffer();

if (typeof window !== 'undefined') window.__vnPageTimings = () => pageTimings.read();
