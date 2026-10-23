/** Monotonic phase durations for diagnostics; independent of provenance timestamps. */
export type TimingPhase =
  | 'queueWaitMs'
  | 'confirmMs'
  | 'flushMs'
  | 'gitStateMs'
  | 'snapshotBeforeMs'
  | 'saveMs'
  | 'projectLoadMs'
  | 'projectReadMs'
  | 'configReadMs'
  | 'inputsReadMs'
  | 'assetsReadMs'
  | 'graphReadMs'
  | 'modelBuildMs'
  | 'projectShotsMs'
  | 'projectRepairMs'
  | 'shotsReadMs'
  | 'sceneReadMs'
  | 'bubbleValidationMs'
  | 'shotsWriteMs'
  | 'coverageBuildMs'
  | 'snapshotAfterMs'
  | 'commitMs'
  | 'recordMs'
  | 'cleanupMs'
  | 'responseMs'
  | 'coverageMs'
  | 'refreshMs';

export interface TimingSample {
  kind: 'command' | 'commitBatch' | 'pageSave' | 'pageReload';
  id: string;
  seqs: number[];
  status: 'ok' | 'error' | 'stale';
  totalMs: number;
  phases: Partial<Record<TimingPhase, number>>;
}

/** Keeps failed operations measurable too, using an injectable monotonic clock. */
export class PhaseTimer {
  readonly phases: TimingSample['phases'] = {};
  private readonly started: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now();
  }

  elapsed(): number {
    return Math.max(0, this.now() - this.started);
  }

  async measure<T>(phase: TimingPhase, body: () => Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await body();
    } finally {
      this.phases[phase] = (this.phases[phase] ?? 0) + Math.max(0, this.now() - start);
    }
  }

  measureSync<T>(phase: TimingPhase, body: () => T): T {
    const start = this.now();
    try {
      return body();
    } finally {
      this.phases[phase] = (this.phases[phase] ?? 0) + Math.max(0, this.now() - start);
    }
  }
}

/** Session diagnostics retain at most 200 samples and never hold command props or document text. */
export class TimingBuffer {
  private readonly samples: TimingSample[] = [];

  add(sample: TimingSample): void {
    this.samples.push(sample);
    if (this.samples.length > 200) this.samples.shift();
  }

  read(): TimingSample[] {
    return this.samples.map((s) => ({ ...s, seqs: [...s.seqs], phases: { ...s.phases } }));
  }
}
