import assert from "node:assert/strict";
import test from "node:test";
import {
  routeAfterCoder,
  routeAfterHuman,
  routeAfterPlanning,
  routeAfterResearch,
  routeAfterReview,
  routeAfterValidation,
  trustedReviewRisks,
} from "../src/routing.js";
import type { WorkflowStateValue } from "../src/state.js";

function state(update: Partial<WorkflowStateValue> = {}): WorkflowStateValue {
  return {
    boundaryViolation: false,
    workerErrorSource: null,
    validationCommands: ["npm test"],
    researchRequired: false,
    researchMode: "auto",
    attempt: 1,
    maxAttempts: 3,
    attemptsExhausted: false,
    reviewRequired: false,
    status: "running",
    ...update,
  } as WorkflowStateValue;
}

test("trusted review risks only escalate known sensitive work", () => {
  assert.deepEqual(trustedReviewRisks("Change button copy", ["src/ui.ts"]), []);
  assert.deepEqual(
    trustedReviewRisks("Update login permissions", ["prisma/migrations/001.sql"]),
    ["authentication or authorization", "database migration"],
  );
});

test("planning routes research, missing validation, worker errors, and boundaries", () => {
  assert.equal(routeAfterPlanning(state({ researchRequired: true })), "research");
  assert.equal(
    routeAfterPlanning(state({ researchRequired: true, researchMode: "off" })),
    "coder",
  );
  assert.equal(routeAfterPlanning(state({ validationCommands: [] })), "human");
  assert.equal(routeAfterPlanning(state({ workerErrorSource: "planner" })), "human");
  assert.equal(routeAfterPlanning(state({ boundaryViolation: true })), "failed");
  assert.equal(routeAfterResearch(state()), "coder");
  assert.equal(routeAfterResearch(state({ workerErrorSource: "research" })), "human");
});

test("Codex and validation retry only before deterministic exhaustion", () => {
  assert.equal(routeAfterCoder(state()), "validation");
  assert.equal(routeAfterCoder(state({ workerErrorSource: "coder" })), "coder");
  assert.equal(
    routeAfterCoder(state({ workerErrorSource: "coder", attemptsExhausted: true })),
    "human",
  );
  assert.equal(routeAfterCoder(state({ boundaryViolation: true })), "failed");

  assert.equal(routeAfterValidation(state({ validationPassed: false })), "coder");
  assert.equal(
    routeAfterValidation(state({ validationPassed: false, attemptsExhausted: true })),
    "human",
  );
  assert.equal(
    routeAfterValidation(state({ validationPassed: true, reviewRequired: true })),
    "reviewer",
  );
  assert.equal(routeAfterValidation(state({ validationPassed: true })), "complete");
});

test("review and human outcomes use explicit routes", () => {
  assert.equal(routeAfterReview(state({ reviewDecision: "approved" })), "complete");
  assert.equal(
    routeAfterReview(state({ reviewDecision: "changes_requested" })),
    "coder",
  );
  assert.equal(
    routeAfterReview(
      state({ reviewDecision: "changes_requested", attemptsExhausted: true }),
    ),
    "human",
  );
  assert.equal(routeAfterReview(state({ reviewDecision: "human_required" })), "human");
  assert.equal(routeAfterReview(state({ workerErrorSource: "reviewer" })), "human");

  assert.equal(routeAfterHuman(state({ humanResponse: "approve" })), "complete");
  assert.equal(
    routeAfterHuman(state({ humanResponse: "accept_with_failed_validation" })),
    "complete",
  );
  assert.equal(routeAfterHuman(state({ humanResponse: "abort" })), "failed");
  assert.equal(
    routeAfterHuman(state({ humanResponse: "retry", resumeTarget: "research" })),
    "research",
  );
});
