import {
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  isGraphInterrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import * as z from "zod";
import {
  runCodex,
  runHermes,
  type PlannerOutput,
  type ResearchOutput,
  type ReviewOutput,
} from "./agents.js";
import {
  assertGitInvariants,
  changedFiles,
  getDataRoot,
  logEvent,
  reviewDiff,
  worktreeEvidence,
  worktreeFingerprint,
  type GitBaseline,
} from "./checkpoint.js";
import { coderPrompt, plannerPrompt, researchPrompt, reviewerPrompt } from "./prompts.js";
import {
  routeAfterCoder,
  routeAfterHuman,
  routeAfterPlanning,
  routeAfterResearch,
  routeAfterReview,
  routeAfterValidation,
  trustedReviewRisks,
} from "./routing.js";
import {
  WorkflowState,
  allowedResponses,
  clearRecoveryState,
  workerFailure,
  type WorkflowStateUpdate,
  type WorkflowStateValue,
} from "./state.js";
import { runValidationCommand } from "./validation.js";

type Dependencies = {
  hermes: typeof runHermes;
  codex: typeof runCodex;
  validate: typeof runValidationCommand;
  dataRoot: string;
};

const ResumePayloadSchema = z.strictObject({
  response: z.string(),
  message: z.string().default(""),
  validationCommands: z.array(z.string().min(1)).default([]),
});

function baseline(state: WorkflowStateValue): GitBaseline {
  return {
    repo: state.repo,
    head: state.baselineHead,
    branch: state.baselineBranch,
  };
}

async function boundaryViolation(
  state: WorkflowStateValue,
  beforeHermesFingerprint?: string,
): Promise<WorkflowStateUpdate | undefined> {
  const gitError = await assertGitInvariants(baseline(state));
  if (gitError) {
    return {
      boundaryViolation: true,
      boundaryEvidence: gitError,
      stopReason: gitError,
      status: "failed",
    };
  }
  if (beforeHermesFingerprint) {
    const after = await worktreeFingerprint(baseline(state));
    if (after !== beforeHermesFingerprint) {
      const evidence = `Hermes changed persistent Git-visible worktree state.\n${await worktreeEvidence(state.repo)}`;
      return {
        boundaryViolation: true,
        boundaryEvidence: evidence,
        stopReason: "Hermes violated its no-write boundary.",
        status: "failed",
      };
    }
  }
  return undefined;
}

function withNextAttempt(state: WorkflowStateValue): WorkflowStateUpdate {
  if (state.attempt < state.maxAttempts) {
    return { attempt: state.attempt + 1, attemptsExhausted: false };
  }
  return { attemptsExhausted: true };
}

function timedNode(
  node: string,
  action: (state: WorkflowStateValue) => WorkflowStateUpdate | Promise<WorkflowStateUpdate>,
) {
  return async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const started = performance.now();
    logEvent("node_start", { runId: state.runId, node, attempt: state.attempt });
    try {
      const update = await action(state);
      logEvent("node_complete", {
        runId: state.runId,
        node,
        attempt: state.attempt,
        durationMs: Math.round(performance.now() - started),
      });
      return update;
    } catch (error) {
      logEvent(isGraphInterrupt(error) ? "node_interrupted" : "node_error", {
        runId: state.runId,
        node,
        attempt: state.attempt,
        durationMs: Math.round(performance.now() - started),
        ...(isGraphInterrupt(error)
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
      });
      throw error;
    }
  };
}

function loggedRoute<T extends string>(
  node: string,
  route: (state: WorkflowStateValue) => T,
) {
  return (state: WorkflowStateValue): T => {
    const transition = route(state);
    logEvent("transition", {
      runId: state.runId,
      node,
      transition,
      attempt: state.attempt,
    });
    return transition;
  };
}

function logCommandResult(
  state: WorkflowStateValue,
  node: string,
  result: { exitCode: number | null; timedOut: boolean; durationMs: number },
): void {
  logEvent("subprocess_result", {
    runId: state.runId,
    node,
    attempt: state.attempt,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  });
}

export function buildGraph(
  checkpointer: BaseCheckpointSaver,
  overrides: Partial<Dependencies> = {},
) {
  const deps: Dependencies = {
    hermes: overrides.hermes ?? runHermes,
    codex: overrides.codex ?? runCodex,
    validate: overrides.validate ?? runValidationCommand,
    dataRoot: overrides.dataRoot ?? getDataRoot(),
  };

  const plannerNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const fingerprint = await worktreeFingerprint(baseline(state));
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const call = await deps.hermes(
      plannerPrompt(state),
      state.repo,
      state.hermesTimeoutMs,
      "planner",
    );
    logCommandResult(state, "planner", call.result);
    const violation = await boundaryViolation(state, fingerprint);
    if (violation) return violation;
    if (!call.output) {
      return {
        ...workerFailure("planner", call.result),
        humanReason: "agent_execution_failed",
      };
    }
    const output = call.output as PlannerOutput;
    const riskReasons = trustedReviewRisks(state.task);
    const reviewRequired =
      output.review_required ||
      state.userRequestedReview ||
      riskReasons.length > 0 ||
      !output.validation_coverage_complete;
    return {
      ...clearRecoveryState(),
      plan: output.plan,
      researchRequired: output.research_required,
      researchReason: output.research_reason,
      reviewRequired,
      reviewReason: output.review_reason,
      reviewRiskReasons: riskReasons,
      validationCoverageComplete: output.validation_coverage_complete,
      plannerSuggestedValidationCommands: output.validation_commands,
      ...(state.validationCommands.length === 0
        ? { humanReason: "validation_commands_missing" as const }
        : {}),
    };
  };

  const researchNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const fingerprint = await worktreeFingerprint(baseline(state));
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const call = await deps.hermes(
      researchPrompt(state),
      state.repo,
      state.hermesTimeoutMs,
      "research",
    );
    logCommandResult(state, "research", call.result);
    const violation = await boundaryViolation(state, fingerprint);
    if (violation) return violation;
    if (!call.output) {
      return {
        ...workerFailure("research", call.result),
        humanReason: "agent_execution_failed",
      };
    }
    return {
      ...clearRecoveryState(),
      researchFindings: (call.output as ResearchOutput).findings,
    };
  };

  const coderNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const call = await deps.codex(
      coderPrompt(state),
      state.repo,
      state.codexTimeoutMs,
      deps.dataRoot,
    );
    logCommandResult(state, "coder", call.result);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const violation = await boundaryViolation(state);
    if (violation) return violation;
    const files = await changedFiles(state.repo);
    if (!call.summary) {
      const retry = withNextAttempt(state);
      return {
        ...workerFailure("coder", call.result),
        ...retry,
        changedFiles: files,
        ...(retry.attemptsExhausted
          ? { humanReason: "codex_execution_failed" as const }
          : {}),
      };
    }
    const risks = [
      ...new Set([...state.reviewRiskReasons, ...trustedReviewRisks(state.task, files)]),
    ];
    return {
      ...clearRecoveryState(),
      implementationResult: call.result,
      implementationSummary: call.summary,
      changedFiles: files,
      reviewRiskReasons: risks,
      reviewRequired: state.reviewRequired || risks.length > 0,
      attemptsExhausted: false,
    };
  };

  const validationNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const results = [];
    for (const command of state.validationCommands) {
      const result = await deps.validate(command, state.repo, state.validationTimeoutMs);
      logCommandResult(state, "validation", result);
      results.push(result);
      if (result.exitCode !== 0 || result.timedOut) break;
    }
    const violation = await boundaryViolation(state);
    if (violation) return violation;
    const passed =
      results.length === state.validationCommands.length &&
      results.every((result) => result.exitCode === 0 && !result.timedOut);
    if (passed) {
      return { validationResults: results, validationPassed: true, attemptsExhausted: false };
    }
    const retry = withNextAttempt(state);
    return {
      validationResults: results,
      validationPassed: false,
      ...retry,
      ...(retry.attemptsExhausted
        ? { humanReason: "validation_failed_exhausted" as const }
        : {}),
    };
  };

  const reviewerNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const [fingerprint, diff] = await Promise.all([
      worktreeFingerprint(baseline(state)),
      reviewDiff(state.repo),
    ]);
    const call = await deps.hermes(
      reviewerPrompt(state, diff),
      state.repo,
      state.hermesTimeoutMs,
      "reviewer",
    );
    logCommandResult(state, "reviewer", call.result);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const violation = await boundaryViolation(state, fingerprint);
    if (violation) return violation;
    if (!call.output) {
      return {
        ...workerFailure("reviewer", call.result),
        humanReason: "agent_execution_failed",
      };
    }
    const output = call.output as ReviewOutput;
    if (output.decision === "changes_requested") {
      const retry = withNextAttempt(state);
      return {
        ...clearRecoveryState(),
        reviewDecision: output.decision,
        reviewResult: output.findings,
        ...retry,
        ...(retry.attemptsExhausted
          ? { humanReason: "review_changes_exhausted" as const }
          : {}),
      };
    }
    return {
      ...clearRecoveryState(),
      reviewDecision: output.decision,
      reviewResult: output.findings,
      ...(output.decision === "human_required"
        ? { humanReason: "review_uncertain" as const }
        : {}),
    };
  };

  const prepareHumanNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const violation = await boundaryViolation(state);
    if (violation) return violation;
    const update = {
      status: "waiting_for_human",
      pausedWorktreeFingerprint: await worktreeFingerprint(baseline(state)),
      changedFiles: await changedFiles(state.repo),
    } as const;
    logEvent("interrupt_created", {
      runId: state.runId,
      reason: state.humanReason,
      attempt: state.attempt,
    });
    return update;
  };

  const humanNode = (state: WorkflowStateValue): WorkflowStateUpdate => {
    if (!state.humanReason) throw new Error("Human checkpoint has no interrupt reason.");
    const payload = ResumePayloadSchema.parse(
      interrupt({
        run_id: state.runId,
        reason: state.humanReason,
        task: state.task,
        attempt: state.attempt,
        validation_summary: state.validationResults
          .flatMap((result) => {
            const out = result.stderr || result.stdout;
            return out ? [out] : [];
          })
          .join("\n"),
        review_summary: state.reviewResult ?? "",
        worker_error: state.workerError,
        planner_suggested_validation_commands: state.plannerSuggestedValidationCommands,
        allowed_responses: allowedResponses[state.humanReason],
        paused_worktree_fingerprint: state.pausedWorktreeFingerprint,
      }),
    );
    if (!allowedResponses[state.humanReason].includes(payload.response)) {
      throw new Error(`Response ${payload.response} is not allowed for ${state.humanReason}.`);
    }
    if (
      ["accept_with_failed_validation", "accept_with_review_findings"].includes(
        payload.response,
      ) &&
      payload.message.trim().length === 0
    ) {
      throw new Error(`${payload.response} requires an acknowledgement message.`);
    }
    const common: WorkflowStateUpdate = {
      status: "running",
      humanResponse: payload.response,
      humanMessage: payload.message,
    };
    if (payload.response === "abort") {
      return { ...common, stopReason: payload.message || `Human aborted ${state.humanReason}.` };
    }
    if (payload.response === "approve") return common;
    if (payload.response === "accept_with_failed_validation") {
      return {
        ...common,
        overrideReasons: [
          ...state.overrideReasons,
          `Failed validation accepted: ${payload.message}`,
        ],
      };
    }
    if (payload.response === "accept_with_review_findings") {
      return {
        ...common,
        overrideReasons: [
          ...state.overrideReasons,
          `Review findings accepted: ${payload.message}`,
        ],
      };
    }
    if (payload.response === "provide_validation") {
      if (payload.validationCommands.length === 0) {
        throw new Error("provide_validation requires at least one trusted validation command.");
      }
      return {
        ...common,
        validationCommands: payload.validationCommands,
        validationSource: "cli",
        resumeTarget:
          state.researchRequired && !state.researchFindings ? "research" : "coder",
      };
    }
    if (payload.response === "retry" && state.workerErrorSource) {
      if (state.workerErrorSource === "coder") {
        return {
          ...common,
          attempt: state.attempt + 1,
          maxAttempts: state.attempt + 1,
          attemptsExhausted: false,
          resumeTarget: "coder",
        };
      }
      return { ...common, resumeTarget: state.workerErrorSource };
    }
    if (payload.response === "revise") {
      return {
        ...common,
        attempt: state.attempt + 1,
        maxAttempts: Math.max(state.maxAttempts, state.attempt + 1),
        attemptsExhausted: false,
        resumeTarget: "coder",
      };
    }
    throw new Error(`Unhandled human response ${payload.response}.`);
  };

  const completeNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const violation = await boundaryViolation(state);
    if (violation) return violation;
    const status = state.overrideReasons.length > 0 ? "completed_with_override" : "completed";
    logEvent("terminal", { runId: state.runId, status, attempt: state.attempt });
    return { status, changedFiles: await changedFiles(state.repo) };
  };

  const failedNode = async (state: WorkflowStateValue): Promise<WorkflowStateUpdate> => {
    const files = await changedFiles(state.repo).catch(() => state.changedFiles);
    const reason =
      state.stopReason || state.boundaryEvidence || state.workerError?.stderr || "Workflow failed.";
    logEvent("terminal", { runId: state.runId, status: "failed", reason });
    return {
      status: "failed",
      changedFiles: files,
      stopReason: reason,
      errors: [...state.errors, reason],
    };
  };

  return new StateGraph(WorkflowState)
    .addNode("planner", timedNode("planner", plannerNode))
    .addNode("research", timedNode("research", researchNode))
    .addNode("coder", timedNode("coder", coderNode))
    .addNode("validation", timedNode("validation", validationNode))
    .addNode("reviewer", timedNode("reviewer", reviewerNode))
    .addNode(
      "prepare_human_checkpoint",
      timedNode("prepare_human_checkpoint", prepareHumanNode),
    )
    .addNode("human_checkpoint", timedNode("human_checkpoint", humanNode))
    .addNode("complete", timedNode("complete", completeNode))
    .addNode("failed", timedNode("failed", failedNode))
    .addEdge(START, "planner")
    .addConditionalEdges("planner", loggedRoute("planner", routeAfterPlanning), {
      research: "research",
      coder: "coder",
      human: "prepare_human_checkpoint",
      failed: "failed",
    })
    .addConditionalEdges("research", loggedRoute("research", routeAfterResearch), {
      coder: "coder",
      human: "prepare_human_checkpoint",
      failed: "failed",
    })
    .addConditionalEdges("coder", loggedRoute("coder", routeAfterCoder), {
      validation: "validation",
      coder: "coder",
      human: "prepare_human_checkpoint",
      failed: "failed",
    })
    .addConditionalEdges("validation", loggedRoute("validation", routeAfterValidation), {
      coder: "coder",
      reviewer: "reviewer",
      human: "prepare_human_checkpoint",
      complete: "complete",
      failed: "failed",
    })
    .addConditionalEdges("reviewer", loggedRoute("reviewer", routeAfterReview), {
      coder: "coder",
      human: "prepare_human_checkpoint",
      complete: "complete",
      failed: "failed",
    })
    .addConditionalEdges(
      "prepare_human_checkpoint",
      loggedRoute("prepare_human_checkpoint", (state) =>
        state.boundaryViolation ? "failed" : "human",
      ),
      { failed: "failed", human: "human_checkpoint" },
    )
    .addConditionalEdges(
      "human_checkpoint",
      loggedRoute("human_checkpoint", routeAfterHuman),
      {
      planner: "planner",
      research: "research",
      coder: "coder",
      reviewer: "reviewer",
      complete: "complete",
      failed: "failed",
      },
    )
    .addEdge("complete", END)
    .addEdge("failed", END)
    .compile({ checkpointer });
}

export function resumeCommand(payload: {
  response: string;
  message?: string;
  validationCommands?: string[];
}) {
  return new Command<
    { response: string; message: string; validationCommands: string[] },
    WorkflowStateUpdate,
    | "planner"
    | "research"
    | "coder"
    | "reviewer"
    | "validation"
    | "prepare_human_checkpoint"
    | "human_checkpoint"
    | "complete"
    | "failed"
  >({
    resume: {
      response: payload.response,
      message: payload.message ?? "",
      validationCommands: payload.validationCommands ?? [],
    },
  });
}
