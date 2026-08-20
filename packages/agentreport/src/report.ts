/**
 * What a report is, as a schema.
 *
 * It lives apart from the analyst that fills it in and the renderer that writes it out, because
 * both paths produce the same shape by two different mechanisms — one structured call, or the
 * args of a `submit_report` tool — and neither should own the definition.
 *
 * Every field is prose the model wrote, so every field goes back through the redactor before it
 * is shown to anyone. The schema cannot enforce that; `analyze` does.
 */
import { z } from 'zod';

export const analysisSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe('one line naming the problem; it becomes the issue title, so no names and no paths'),
  whatHappened: z.string().min(1).describe('the sequence, in general terms'),
  whatWentWrong: z
    .array(z.string())
    .default([])
    .describe('each thing the agent did wrong, one per entry'),
  rootCause: z.string().min(1).describe('the single best explanation, or why none is available'),
  recommendations: z
    .array(
      z.object({
        behaviour: z.string().min(1).describe('what the agent should do instead, stated as a rule'),
        where: z.string().optional().describe('the file or tool it belongs in, if you know one'),
        rationale: z.string().min(1).describe('what it prevents'),
      }),
    )
    .default([])
    .describe('recommendations for new behaviour — the point of the report'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('how sure you are, given how much the transcript actually recorded'),
  evidence: z
    .array(z.string())
    .default([])
    .describe('short quotes from the transcript that support the finding'),
});

/** The analyst's findings. */
export type Analysis = z.infer<typeof analysisSchema>;

/**
 * The same schema, typed as taking and producing `Analysis`.
 *
 * The defaulted arrays make zod's input type differ from its output, since a model may omit
 * `evidence` and still be understood. Both consumers need one `T` at both ends:
 * `withStructuredRetry` and the tool registry are each typed `ZodType<T>`.
 */
export const analysisArgs = analysisSchema as unknown as z.ZodType<Analysis>;

/** A finished report: the findings, plus how they were arrived at. */
export interface Report {
  analysis: Analysis;
  /** The model that wrote it. */
  model: string;
  /**
   * Whether the analyst actually read the source. False when the author declined it, and also
   * when it was offered and the run fell back — a reader of the issue is told which, because the
   * weight of a recommendation about a specific file depends on it.
   */
  readSource: boolean;
  /** Set when the source was offered and the agent path did not produce a report. */
  fellBack?: string;
}
