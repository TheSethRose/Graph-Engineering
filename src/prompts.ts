import type { WorkflowStateValue } from "./state.js";

export function plannerPrompt(state: WorkflowStateValue): string {
  return `You are the read-only planner in a fixed development workflow.
Repository: ${state.repo}
Task: ${state.task}

Inspect the repository as needed, but do not modify any file or run Codex. Keep scope exact.
Return only one JSON object with this shape:
{"plan":"concrete plan","research_required":false,"research_reason":"","review_required":false,"review_reason":"","validation_coverage_complete":true,"validation_commands":["advisory command"]}
Validation commands are advisory only. Do not wrap the JSON in Markdown.`;
}

export function researchPrompt(state: WorkflowStateValue): string {
  return `You are the read-only research worker in a fixed development workflow.
Repository: ${state.repo}
Task: ${state.task}
Plan: ${state.plan ?? ""}
Research reason: ${state.researchReason}

Research only the stated gap. Do not modify repository files and do not run Codex.
Return only JSON: {"findings":"concise implementation-relevant findings"}.`;
}

export function coderPrompt(state: WorkflowStateValue): string {
  const failedValidation = state.validationResults
    .flatMap((result) => {
      if (result.exitCode !== 0 || result.timedOut) {
        return [`${result.argv.join(" ")}\n${result.stderr || result.stdout}`];
      }
      return [];
    })
    .join("\n\n");
  return `You are the only coding worker in a controlled local workflow.
Repository: ${state.repo}
Task: ${state.task}
Attempt: ${state.attempt} of ${state.maxAttempts}
Plan: ${state.plan ?? ""}
Research: ${state.researchFindings}
Prior validation failures: ${failedValidation || "none"}
Review feedback: ${state.reviewResult ?? "none"}
Human guidance: ${state.humanMessage ?? "none"}

Inspect the current worktree, including partial edits from prior attempts. Make only the requested repository changes, preserve existing conventions, and run useful local checks when practical.
Do not push, deploy, commit, reset, clean, switch branches, or open a pull request.
Return a concise structured summary when finished.`;
}

export function reviewerPrompt(state: WorkflowStateValue, diff: string): string {
  const validation = state.validationResults
    .map(
      (result) =>
        `${result.argv.join(" ")} → ${result.timedOut ? "timeout" : `exit ${result.exitCode}`}\n${result.stderr || result.stdout}`,
    )
    .join("\n\n");
  return `You are the read-only reviewer in a fixed development workflow.
Task: ${state.task}
Plan: ${state.plan ?? ""}
Research: ${state.researchFindings}
Codex summary: ${state.implementationSummary}
Validation passed: ${String(state.validationPassed)}
Validation results: ${validation}
Review reasons: ${[state.reviewReason, ...state.reviewRiskReasons].filter(Boolean).join("; ")}
Git diff:\n${diff}

Do not modify files and do not run Codex. Review correctness and scope.
Return only JSON with exactly one decision:
{"decision":"approved|changes_requested|human_required","findings":"concise evidence"}.`;
}
