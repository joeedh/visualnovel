const REDACTED = '<redacted>';

/** Credential-bearing query parameters, as a vendor error quoting its request URL shows them. */
const QUERY_KEY = /([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"'<>]+/gi;

/** Credential headers, in `name: value` and JSON `"name": "value"` forms. */
const HEADER_KEY =
  /((?:authorization|x-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;}]+/gi;

/** The vendors' own key shapes, wherever they appear. */
const KEY_SHAPES = /\b(?:sk-ant-[\w-]{8,}|sk-or-[\w-]{8,}|sk-[A-Za-z0-9_-]{20,}|AIza[\w-]{30,})/g;

/**
 * Removes API keys from text that is about to be written somewhere a person reads, such as an
 * error message quoting the request that failed. Idempotent.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(QUERY_KEY, `$1${REDACTED}`)
    .replace(HEADER_KEY, `$1${REDACTED}`)
    .replace(KEY_SHAPES, REDACTED);
}
