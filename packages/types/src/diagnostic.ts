/** A validation diagnostic produced while building the project model (report §P0). */
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** Entity id the diagnostic concerns, when applicable. */
  where?: string;
}
