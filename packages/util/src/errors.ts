/** Typed error hierarchy so callers can branch on failure class (report §10). */

export class VnError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Bad input: malformed front-matter, dangling goto, invalid config. */
export class ValidationError extends VnError {
  readonly diagnostics: { code: string; message: string; where?: string }[];
  constructor(message: string, diagnostics: ValidationError['diagnostics'] = []) {
    super('VALIDATION', message);
    this.diagnostics = diagnostics;
  }
}

/**
 * A provider call failed terminally: a content refusal, a malformed request, an unusable
 * reference image. Another attempt buys the same answer at another attempt's price.
 * {@link RetryableProviderError} is the transient case.
 */
export class ProviderError extends VnError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('PROVIDER', message, options);
  }
}

/**
 * A provider call failed in a way another attempt could plausibly fix — a 429, a 5xx, a dropped
 * connection. Only the backend can tell the two apart, since it is the layer that sees the
 * status code; everything above branches on this class.
 */
export class RetryableProviderError extends ProviderError {}

/** Structured model output could not be parsed/validated after retries. */
export class StructuredOutputError extends VnError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('STRUCTURED_OUTPUT', message, options);
  }
}

/** Configuration problem: missing key, unreadable project.yaml. */
export class ConfigError extends VnError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CONFIG', message, options);
  }
}
