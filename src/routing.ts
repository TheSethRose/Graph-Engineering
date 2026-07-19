import type { WorkflowStateValue } from "./state.js";

export function trustedReviewRisks(
  task: string,
  changedFiles: readonly string[] = [],
): string[] {
  const haystack = `${task}\n${changedFiles.join("\n")}`.toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["authentication or authorization", /\b(auth|oauth|login|permission|role|acl)\b/],
    ["security-sensitive change", /\b(security|secret|credential|crypto|csp|csrf|xss)\b/],
    ["database migration", /\b(migration|migrations|schema\.sql|prisma\/migrations)\b/],
    ["public API or schema", /\b(public api|openapi|graphql|api\/|schema)\b/],
  ];
  return rules.flatMap(([reason, pattern]) => (pattern.test(haystack) ? [reason] : []));
}

function boundaryOrWorkerFailure(
  state: WorkflowStateValue,
): "failed" | "human" | undefined {
  if (state.boundaryViolation) return "failed";
  if (state.workerErrorSource) return "human";
  return undefined;
}

export function routeAfterPlanning(
  state: WorkflowStateValue,
): "research" | "coder" | "human" | "failed" {
  const failure = boundaryOrWorkerFailure(state);
  if (failure) return failure;
  if (state.validationCommands.length === 0) return "human";
  return state.researchRequired && state.researchMode !== "off" ? "research" : "coder";
}

export function routeAfterResearch(
  state: WorkflowStateValue,
): "coder" | "human" | "failed" {
  return boundaryOrWorkerFailure(state) ?? "coder";
}

export function routeAfterCoder(
  state: WorkflowStateValue,
): "validation" | "coder" | "human" | "failed" {
  if (state.boundaryViolation) return "failed";
  if (state.workerErrorSource === "coder") {
    return state.attemptsExhausted ? "human" : "coder";
  }
  return "validation";
}

export function routeAfterValidation(
  state: WorkflowStateValue,
): "coder" | "reviewer" | "human" | "complete" | "failed" {
  if (state.boundaryViolation) return "failed";
  if (!state.validationPassed) {
    return state.attemptsExhausted ? "human" : "coder";
  }
  return state.reviewRequired ? "reviewer" : "complete";
}

export function routeAfterReview(
  state: WorkflowStateValue,
): "coder" | "human" | "complete" | "failed" {
  const failure = boundaryOrWorkerFailure(state);
  if (failure) return failure;
  if (state.reviewDecision === "approved") return "complete";
  if (state.reviewDecision === "changes_requested") {
    return state.attemptsExhausted ? "human" : "coder";
  }
  return "human";
}

export function routeAfterHuman(
  state: WorkflowStateValue,
): "planner" | "research" | "coder" | "reviewer" | "complete" | "failed" {
  if (state.humanResponse === "abort") return "failed";
  if (
    state.humanResponse === "approve" ||
    state.humanResponse === "accept_with_failed_validation" ||
    state.humanResponse === "accept_with_review_findings"
  ) {
    return "complete";
  }
  return state.resumeTarget ?? "failed";
}
