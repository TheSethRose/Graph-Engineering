import { StateSchema } from "@langchain/langgraph";
import * as z from "zod";

export const OUTPUT_LIMIT_BYTES = 128 * 1024;

export const CommandResultSchema = z.object({
  argv: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

export type CommandResult = z.infer<typeof CommandResultSchema>;

export const InterruptReasonSchema = z.enum([
  "review_uncertain",
  "review_changes_exhausted",
  "validation_failed_exhausted",
  "validation_commands_missing",
  "agent_execution_failed",
  "codex_execution_failed",
]);

export type InterruptReason = z.infer<typeof InterruptReasonSchema>;

const ReviewDecisionSchema = z.enum([
  "approved",
  "changes_requested",
  "human_required",
]);

export const WorkflowState = new StateSchema({
  runId: z.string(),
  task: z.string(),
  repo: z.string(),
  baselineHead: z.string(),
  baselineBranch: z.string(),
  changedFiles: z.array(z.string()).default([]),
  pausedWorktreeFingerprint: z.string().optional(),

  plan: z.string().optional(),
  plannerSuggestedValidationCommands: z.array(z.string()).default([]),
  researchRequired: z.boolean().default(false),
  researchReason: z.string().default(""),
  researchFindings: z.string().default(""),
  researchMode: z.enum(["auto", "off"]).default("auto"),

  implementationResult: CommandResultSchema.optional(),
  implementationSummary: z.string().default(""),

  validationCommands: z.array(z.string()).default([]),
  validationSource: z.enum(["cli", "repo_config"]).optional(),
  validationResults: z.array(CommandResultSchema).default([]),
  validationPassed: z.boolean().optional(),
  validationCoverageComplete: z.boolean().default(false),

  userRequestedReview: z.boolean().default(false),
  reviewRequired: z.boolean().default(false),
  reviewReason: z.string().default(""),
  reviewRiskReasons: z.array(z.string()).default([]),
  reviewResult: z.string().optional(),
  reviewDecision: ReviewDecisionSchema.optional(),

  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  attemptsExhausted: z.boolean().default(false),

  humanReason: InterruptReasonSchema.optional(),
  humanResponse: z.string().optional(),
  humanMessage: z.string().optional(),
  overrideReasons: z.array(z.string()).default([]),
  resumeTarget: z.enum(["planner", "research", "coder", "reviewer"]).optional(),

  workerErrorSource: z
    .enum(["planner", "research", "coder", "reviewer"])
    .nullable()
    .default(null),
  workerError: CommandResultSchema.nullable().default(null),

  boundaryViolation: z.boolean().default(false),
  boundaryEvidence: z.string().default(""),
  stopReason: z.string().default(""),
  status: z.enum([
    "running",
    "waiting_for_human",
    "completed",
    "completed_with_override",
    "failed",
    "cancelled",
  ]),
  errors: z.array(z.string()).default([]),

  hermesTimeoutMs: z.number().int().positive(),
  codexTimeoutMs: z.number().int().positive(),
  validationTimeoutMs: z.number().int().positive(),
});

export type WorkflowStateValue = typeof WorkflowState.State;
export type WorkflowStateUpdate = typeof WorkflowState.Update;

export const allowedResponses: Record<InterruptReason, readonly string[]> = {
  review_uncertain: ["approve", "revise", "abort"],
  review_changes_exhausted: [
    "accept_with_review_findings",
    "revise",
    "abort",
  ],
  validation_failed_exhausted: [
    "accept_with_failed_validation",
    "revise",
    "abort",
  ],
  validation_commands_missing: ["provide_validation", "abort"],
  agent_execution_failed: ["retry", "abort"],
  codex_execution_failed: ["retry", "abort"],
};

export function workerFailure(
  source: "planner" | "research" | "coder" | "reviewer",
  result: CommandResult,
): WorkflowStateUpdate {
  return {
    workerErrorSource: source,
    workerError: result,
  };
}

export function clearRecoveryState(): WorkflowStateUpdate {
  return {
    workerErrorSource: null,
    workerError: null,
    humanReason: undefined,
    humanResponse: undefined,
    humanMessage: undefined,
    resumeTarget: undefined,
  };
}
