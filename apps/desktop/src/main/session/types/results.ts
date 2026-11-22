import type { Report } from '@vn/agentreport';

/** What a chunk edit does to one clause — `prompt.setChunk`'s `op`. */
export type ChunkOp = 'replace' | 'append' | 'mute' | 'clear';

/** Which half of an override `prompt.clear` discards. */
export type ClearPart = 'all' | 'chunks' | 'order' | 'custom' | 'agent';

/** What a prompt preview answers: would this be allowed, and what would it say. */
export interface PromptResult {
  ok: boolean;
  message: string;
}

/**
 * What the report dialog asked for, before anything about it has been resolved. Every string may
 * be empty, and empty means the default — the newest conversation, the bound model, the bound
 * effort stepped up.
 */
export interface ReportAsk {
  thread: string;
  note: string;
  source: boolean;
  /** Whether the analyst may read the requests this session sent. Off unless the box is ticked. */
  detail?: boolean;
  model: string;
  effort: string;
}

/** A finished analysis: the findings, the markdown they render to, and where a copy was kept. */
export interface ReportDraft {
  report: Report;
  /** The issue title, `AGENTREPORT:`-prefixed, so the preview does not re-derive one. */
  title: string;
  body: string;
  /** Absent when there was nowhere to write one, or the write failed. */
  file?: string;
}

/** Where `report.openIssue` sent the author. */
export interface IssueOpened {
  url: string;
}

/** The same, plus the files a write touched — the shape every `prompt.*` mutator returns. */
export interface PromptWriteResult extends PromptResult {
  written: string[];
}

/** The four things `doc.create` scaffolds. A note is a title and nothing else. */
export type NewDocKind = 'character' | 'location' | 'note' | 'skill';
