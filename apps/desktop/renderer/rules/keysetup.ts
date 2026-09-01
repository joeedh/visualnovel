/**
 * The one prop the setup pane's key box holds rather than records.
 *
 * `project.setKey` declares `key` as `prop.secret`, so it is redacted at `digestProps` and never
 * persisted. An anchor must therefore name it as something the widget supplies and never carry its
 * value: an anchor is dumped to `window.__vnAnchors` and swept to a file on disk.
 */
export const KEY_SUPPLIES = ['key'];
