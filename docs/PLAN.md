# Hermes + Codex Agentic Graph Workflow

## Project

Build a minimal graph-based development workflow where:

- **LangGraph** owns workflow execution, routing, retries, checkpoints, and human interrupts.
- **Hermes Agent** performs planning, optional research, and code review.
- **Codex CLI** performs repository changes directly.
- **Shell commands** perform deterministic validation.
- **SQLite** stores LangGraph checkpoints locally.

The system must remain small, local, and understandable. It is not a general-purpose agent platform.

**Status:** Implemented local architecture in strict TypeScript on Bun. The first release includes the fixed graph, CLI, Bun-native SQLite persistence, tests, terminal UI, and repository-local Hermes skill described below.

## Goal

Create a reusable development workflow that converts a repository task into a controlled execution graph:

```text
START
  ↓
Planner: Hermes
  ↓
Research required?
  ├── yes → Research: Hermes or deterministic tool
  └── no
          ↓
Coder: Codex
  ↓
Validation: shell commands
  ├── failed and retries remain → Coder
  ├── failed and retries exhausted → Human checkpoint or FAILED
  └── passed
          ↓
Review required?
  ├── yes → Reviewer: Hermes
  │           ├── approved → Complete
  │           ├── changes requested → Coder
  │           └── human decision required → Human checkpoint
  └── no → Complete
```

The graph should improve reliability without adding orchestration overhead to simple tasks.

## Non-goals

Do not build:

- a visual graph editor or dynamic graph generator;
- a general-purpose agent framework;
- a hosted API, web dashboard, MCP server, task queue, or background worker;
- a plugin system or custom memory system;
- a replacement for Hermes, Codex, GitHub Actions, or a deployment platform;
- automatic skill creation; or
- automatic commits, pushes, pull requests, deployments, resets, or destructive cleanup.

Hermes must not generate LangGraph definitions at runtime. Codex must be invoked directly by LangGraph rather than routed through Hermes.

## Ownership model

### LangGraph

LangGraph is the authoritative workflow runtime. It owns the reviewed graph definition, node execution order, conditional routing, shared state, retry limits, checkpoints, pause and resume behavior, human interrupts, run status, and terminal outcomes.

### Hermes Agent

Hermes is an intelligent worker used only inside selected nodes. It may plan, analyze repository context, research, identify risk, review code, and evaluate ambiguous failures. It does not own workflow state, graph position, retry counters, checkpoint persistence, routing, Codex execution, or interrupt state.

Hermes memory may supply background context, but it is never authoritative for graph execution.

### Codex CLI

Codex is the only coding worker. It inspects the selected repository, edits within task scope, follows existing conventions, responds to test or review feedback, and summarizes its work. It does not decide graph transitions and must not push, deploy, or open a pull request.

### Shell validation

Deterministic project commands validate the change. Their exit codes are authoritative; an LLM must not reinterpret a failing command as a pass.

Examples include:

```bash
bun run test
bun run typecheck
bun run lint
pytest
cargo test
go test ./...
```

### SQLite checkpointer

SQLite stores the LangGraph state needed to inspect and resume a local run: completed outputs, pending nodes, retry counts, validation and review results, and interrupt state. It is sufficient while execution remains synchronous and single-process.

## Core design principles

1. **Fixed graphs.** Graphs are reviewed TypeScript code. Add another graph only after another repeated workflow is proven necessary.
2. **Conditional intelligence.** Do not call Hermes when deterministic logic is sufficient. Specific tasks can skip research; low-risk tasks with strong validation can skip review only after deterministic risk rules agree.
3. **Direct Codex execution.** The coding path is `LangGraph → Codex CLI`, never `LangGraph → Hermes → Codex CLI`.
4. **Separate memory from state.** LangGraph stores facts required for this run. Hermes memory stores optional reusable context. The workflow must still work when Hermes memory is unavailable.
5. **Bounded retries.** Every loop has an explicit maximum. The default is `maxAttempts = 3`; exhaustion pauses for a human instead of silently extending the limit.
6. **Deterministic validation.** Tests, type checking, and linting run as commands and pass only on exit code `0`.
7. **Human approval only when justified.** Interrupt for ambiguous decisions, security-sensitive or destructive work, deployment, repeated failures, scope expansion, or behavior that tests cannot establish.

## Initial scope

The first version supports one workflow:

```text
plan → optional research → implement → validate → optional review
```

It supports one clean local Git repository on macOS or Unix, one Codex worker, Hermes planning, optional Hermes research and review, one or more validation commands, bounded retry loops, SQLite checkpoints, stable run IDs, status inspection, human interruption, and resume. It does not support concurrent execution; `run` and `resume` hold one global process lock and a second writer fails clearly. Windows support is deferred until its process, shell, and locking contracts are designed and tested explicitly.

## Project structure

```text
graph-engineering/
├── package.json
├── bun.lock
├── tsconfig.json
├── .env.example
├── README.md
├── docs/
│   ├── PLAN.md
│   ├── RESEARCH.md
│   └── graph-engineering-infographic.png
├── .gitignore
├── .agents/skills/agent-workflow/SKILL.md
├── compat/better-sqlite3/
├── src/
│   ├── cli.ts
│   ├── events.ts
│   ├── graph.ts
│   ├── tui.ts
│   ├── state.ts
│   ├── routing.ts
│   ├── agents.ts
│   ├── validation.ts
│   ├── prompts.ts
│   └── checkpoint.ts
├── tests/
│   ├── agents.test.ts
│   ├── cli.test.ts
│   ├── routing.test.ts
│   ├── tui.test.ts
│   ├── validation.test.ts
│   └── graph.test.ts
```

Keep modules small. Do not introduce dependency-injection frameworks, repository layers, abstract base classes, or a prompt framework until multiple concrete implementations require them.

## Dependencies

Use strict TypeScript on Bun 1.3 or newer. Bun owns installation, execution, tests, global linking, and SQLite.

```json
{
  "type": "module",
  "packageManager": "bun@1.3.13",
  "engines": {
    "bun": ">=1.3 <2"
  },
  "dependencies": {
    "@langchain/core": "1.2.3",
    "@langchain/langgraph": "1.4.8",
    "@langchain/langgraph-checkpoint-sqlite": "1.0.3",
    "better-sqlite3": "file:./compat/better-sqlite3",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/bun": "1.3.14",
    "eslint": "^10.7.0",
    "react-doctor": "^0.8.1",
    "typescript": "npm:@typescript/typescript6@^6.0.2",
    "typescript-eslint": "^8.64.0"
  },
  "overrides": {
    "better-sqlite3": "file:./compat/better-sqlite3"
  }
}
```

Exact package versions are resolved in `bun.lock`. The local `better-sqlite3` compatibility package maps the small synchronous driver surface required by the official LangGraph saver to `bun:sqlite`; do not copy or fork the saver itself. Do not install the broad `langchain` package, a CLI framework, an ORM, a subprocess wrapper, or another test framework unless a concrete gap appears. Use Bun's Node-compatible standard library for existing process and filesystem APIs and `bun:test` for tests.

## Prerequisites

The user must already be authenticated with Hermes and Codex. The workflow does not manage credentials. These commands must work independently:

```bash
hermes -z "Reply with exactly HERMES_OK"
codex exec --sandbox read-only "Reply with exactly CODEX_OK"
```

The implementation feature-detects the required command flags and fails clearly when an installed CLI is incompatible, so it does not depend on a particular local installation.

## Workflow state

Use one typed state object and store only data needed to route, validate, resume, or explain a run.

```typescript
import * as z from "zod";
import { StateSchema } from "@langchain/langgraph";

export const CommandResultSchema = z.object({
  argv: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

export const WorkflowState = new StateSchema({
  runId: z.string(),
  task: z.string(),
  repo: z.string(),
  baselineHead: z.string(),
  baselineBranch: z.string(),
  changedFiles: z.array(z.string()).default([]),
  pausedWorktreeFingerprint: z.string().optional(),

  plan: z.string().optional(),
  researchRequired: z.boolean().default(false),
  researchReason: z.string().default(""),
  researchFindings: z.string().default(""),

  implementationResult: CommandResultSchema.optional(),

  validationCommands: z.array(z.string()).default([]),
  validationSource: z.enum(["cli", "repo_config", "agents"]).optional(),
  validationResults: z.array(CommandResultSchema).default([]),
  validationPassed: z.boolean().optional(),
  validationCoverageComplete: z.boolean().default(false),

  userRequestedReview: z.boolean().default(false),
  reviewRequired: z.boolean().default(false),
  reviewReason: z.string().default(""),
  reviewRiskReasons: z.array(z.string()).default([]),
  reviewResult: z.string().optional(),
  reviewDecision: z.enum([
    "approved",
    "changes_requested",
    "human_required",
  ]).optional(),

  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),

  humanReason: z.string().optional(),
  humanResponse: z.string().optional(),
  humanMessage: z.string().optional(),
  overrideReasons: z.array(z.string()).default([]),

  workerErrorSource: z.enum([
    "planner",
    "research",
    "coder",
    "reviewer",
  ]).nullable().default(null),
  workerError: CommandResultSchema.nullable().default(null),

  status: z.enum([
    "running",
    "waiting_for_human",
    "completed",
    "completed_with_override",
    "failed",
    "cancelled",
  ]),
  errors: z.array(z.string()).default([]),
});
```

Do not place conversational history, subprocess objects, database connections, exceptions, secrets, or full environment data in state. Captured worker and validation output is truncated at 128 KiB before checkpointing. Reviewer diffs are capped at 512 KiB and state that they were truncated when the cap is reached.

## Runtime data, Git baseline, and leases

Runtime data must never live in this project or a target repository. Resolve one user-level directory, honoring XDG:

```typescript
const dataRoot = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "agent-workflow",
);
```

```text
~/.local/share/agent-workflow/
├── checkpoints.sqlite3
├── agent-workflow.lock
└── active-runs.json
```

The displayed path is the default when `XDG_DATA_HOME` is unset. Create the directory with user-only permissions where the platform supports them.

Version one requires a Git repository root on a named branch, but the source may contain existing changes. Before calling an agent:

```text
active branch resolves to a name
  → capture source HEAD and branch, create a run ID, then continue

HEAD is detached
  → refuse to start without changing anything
```

Create an isolated detached Git worktree under `<data_root>/workspaces/<run_id>` at the source HEAD. Apply the source's tracked diff and copy its non-ignored untracked files into that workspace, then populate a private alternate Git index with the seeded state. If the source has `node_modules`, expose it to the workspace through a symlink so ordinary repository validation remains usable without reinstalling dependencies. Workers and validation commands run only in this workspace.

Record the workspace HEAD in state and require it to remain unchanged through every worker, resume, and terminal node. A mismatch is a boundary violation: stop as `failed`, preserve the workspace, and report the evidence. Derive workflow-only changed files and review diffs against the private index, including non-ignored untracked additions. Ignored files are outside version one's attribution guarantee. Never reset, clean, switch branches, or attempt recovery automatically.

On `completed` or `completed_with_override`, generate the workflow-only binary patch, run `git apply --check` against the source repository, and apply it only when the check succeeds. Remove the workspace and private index after a successful application. If the source changed incompatibly, mark the run failed, leave the source unchanged by reconciliation, and preserve the workspace and patchable state for manual recovery.

Acquire one advisory process lock at `<data_root>/agent-workflow.lock` around the entire `run` or `resume` operation. Use an atomic `node:fs` exclusive-create operation, record the owner PID, remove the lock in `finally`, and reclaim it only after verifying that the recorded process no longer exists. Hold the lock until execution pauses or terminates. `status` remains read-only and does not need the lock. A second live writer exits clearly; it never waits indefinitely or shares the target repository or SQLite writer.

The process lock is released when an interrupt returns control, so persist a repository lease in `<data_root>/active-runs.json`. Update the JSON atomically while holding the process lock. Key leases by canonical absolute repository path:

```json
{
  "/absolute/path/to/repo": {
    "run_id": "019abc",
    "status": "waiting_for_human",
    "pid": 12345,
    "workspace": "/data/root/workspaces/019abc",
    "updated_at": "2026-07-19T12:00:00.000Z"
  }
}
```

A new run refuses a repository with a paused lease or a running lease whose recorded PID is alive. It automatically replaces a running lease when that PID is absent or dead, logging the reclaimed run ID. Create the lease before the first worker call and retain it across pauses and recoverable worker failures. Remove it on terminal completion, failure, abort, caught unexpected exceptions, `SIGINT`, and `SIGTERM`; preserve the last checkpoint and isolated workspace when execution did not reconcile successfully. A hard crash can leave a running lease, but the next run reclaims it after verifying that its owner is dead. Never auto-reclaim a `waiting_for_human` lease.

Immediately before every interrupt, store `paused_worktree_fingerprint`. Compute a stable SHA-256 over the isolated workspace's recorded HEAD and branch, `git diff --binary HEAD`, and sorted path/content hashes for files returned by `git ls-files --others --exclude-standard -z`. This covers persistent Git-visible tracked changes and non-ignored untracked files, but not ignored files or external side effects.

On resume, acquire the process lock, confirm the lease belongs to the requested run, recompute the fingerprint, and compare it before invoking LangGraph:

```text
fingerprint matches
  → resume

fingerprint changed
  → refuse resume and retain the paused lease for manual reconciliation
```

The source repository does not participate in the resume fingerprint. It may change while the run is paused; the checked terminal reconciliation determines whether the workflow-only patch still applies.

## Nodes

### Planner

**Worker:** Hermes

The planner converts the exact task into a bounded implementation plan. It may inspect repository context, identify likely files and validation commands, decide whether external research or independent review adds value, flag security or migration risk, and preserve the requested scope.

It must not modify the repository, implement the task, expand the scope, generate graph definitions, or decide transitions outside its structured response.

Expected output:

```json
{
  "plan": "Concrete implementation plan",
  "research_required": false,
  "research_reason": "",
  "review_required": true,
  "review_reason": "Change affects authentication behavior",
  "validation_coverage_complete": true,
  "validation_commands": [
    "bun run typecheck",
    "bun run test"
  ]
}
```

Use `hermes -z` with a strict JSON-only prompt. Validate every routing field before updating state; malformed output routes to a human or a recoverable failure rather than being guessed.

Catch expected Hermes CLI failures, timeouts, and structured-output parsing failures. Store `workerErrorSource = "planner"` plus `workerError`, then route to an `agent_execution_failed` interrupt. Unexpected application defects still throw and leave the last checkpoint intact.

Planner-selected validation commands become executable only when each one exactly matches a command in a validation-related section of a tracked root `AGENTS.md`. Unmatched suggestions remain advisory, and the workflow pauses when no trusted command remains.

### Deterministic review escalation

Planner output can require review but cannot suppress it. After planning, compute the effective decision in workflow code:

```typescript
const reviewRiskReasons = trustedReviewRisks(task, repoContext);
const reviewRequired =
  plannerOutput.review_required ||
  userRequestedReview ||
  reviewRiskReasons.length > 0 ||
  !plannerOutput.validation_coverage_complete;
```

Keep `trustedReviewRisks()` small and deterministic. It escalates authentication or authorization changes, security-related files or dependencies, database migrations, public API or schema changes, and explicitly incomplete validation coverage. Re-run the same one-way escalation after coding against the actual changed-file list, because planning-time context may not predict the final diff. A risk rule may change review from `false` to `true`; nothing may clear a review already required by the user, planner, or another rule.

### Research

**Worker:** Hermes or a configured deterministic research command

Run only when `research_required` identifies a real gap such as current API behavior, library documentation, security guidance, compatibility uncertainty, or a referenced external artifact. `research_mode: "off"` suppresses this optional step both after planning and when a missing-validation pause resumes. Ordinary repository inspection is not research.

The result is concise implementation input for Codex. Research never writes repository files or decides graph routing. Expected Hermes CLI, timeout, or parsing failures store `workerErrorSource = "research"` and route to `agent_execution_failed`; unexpected application errors throw normally.

### Coder

**Worker:** Codex CLI

The coder receives the exact user task, Hermes plan, relevant research, prior validation failures, reviewer feedback, and attempt count. Validation diagnostics are bounded before entering the prompt so one noisy command cannot consume the next attempt's context; the complete captured result remains in checkpoint state. Codex must inspect the current working tree, preserve unrelated behavior, make only required edits, follow repository rules, run useful checks when practical, and leave a reviewable diff.

Invoke Codex directly and explicitly retain its sandbox:

```bash
codex --ask-for-approval never exec \
  --cd "/absolute/repository/path" \
  --sandbox workspace-write \
  --strict-config \
  -c 'sandbox_workspace_write.network_access=false' \
  -c 'web_search="disabled"' \
  --output-schema "/path/to/codex-result.schema.json" \
  --output-last-message "/temporary/path/codex-result.json" \
  "<implementation prompt>"
```

Do not use `--dangerously-bypass-approvals-and-sandbox`. The inline settings override user configuration for this invocation: shell network access is disabled and web search is disabled instead of inheriting Codex's cached-search default. `--strict-config` turns an unsupported or misspelled setting into a clear failure.

Codex is instructed not to push, deploy, commit, reset, clean, or switch branches. `workspace-write` does not enforce those semantic Git restrictions, so the workflow independently verifies that the captured HEAD and active branch have not changed. Network disabling prevents shell commands from pushing or deploying through the network; the workflow still treats Git invariant checks as required defense in depth.

A zero exit clears the worker-error fields and routes to validation. A nonzero exit, timeout, or expected CLI failure stores `workerErrorSource = "coder"` and `workerError`; it retries Codex while attempts remain, then routes to a `codex_execution_failed` interrupt. Partial edits remain in the worktree for the next Codex attempt to inspect. Successful retries by any worker clear their prior worker-error fields. Unexpected application defects throw and retain the last checkpoint.

### Validation

**Worker:** deterministic subprocesses

Run trusted validation commands sequentially and stop at the first failure. Invoke each non-empty command through `/bin/sh -c` so the command inherits the workflow environment. Caller input, checked-in configuration, and exact command matches from checked-in instructions are trusted-code boundaries; package scripts can already execute arbitrary local code, so a partial shell parser would not create a meaningful security boundary.

Version one has three trusted command sources, in precedence order:

1. Repeated `--validate` arguments supplied by the caller.
2. `validation_commands` in a Git-tracked `.agent-workflow.json` at the selected repository root.
3. Planner selections that exactly match commands in setup, build, test, validation, or check sections of a regular, non-symlinked, Git-tracked root `AGENTS.md`.

CLI commands replace the JSON list rather than merging with it, and a non-empty JSON list suppresses automatic `AGENTS.md` selection. Do not discover package scripts or execute undocumented planner output. Negated command instructions and commands outside validation-related sections are not eligible. When no trusted source provides a command, pause before Codex with interrupt reason `validation_commands_missing`; resume requires caller-supplied `--validate` arguments or abort.

Capture the argv, exit code, stdout, stderr, duration, and timeout. Validation passes only when every command exits `0`. Feed Codex and the reviewer a bounded head-and-tail excerpt instead of the entire captured result. A shell `127`, Node native-module ABI mismatch, or package-engine mismatch pauses as `validation_environment_failed` without incrementing the coding attempt; after correcting the environment, `retry` reruns validation directly.

```text
validation failed
  ├── attempt < maxAttempts → coder
  └── attempt >= maxAttempts → human checkpoint
```

### Reviewer

**Worker:** Hermes

Run when requested by the user or planner, or when the change affects authentication, authorization, security, migrations, public APIs, or behavior that tests do not fully establish. Review the original task, plan, research, Git diff, validation results, and Codex summary. Bound the combined validation transcript and review diff before constructing the model prompt.

The reviewer does not modify files and returns exactly one decision:

```text
APPROVED
CHANGES_REQUESTED
HUMAN_REQUIRED
```

Approval completes the workflow. Requested changes return to Codex while attempts remain. Uncertainty or exhausted retries route to the human checkpoint.

Expected Hermes CLI, timeout, or parsing failures store `workerErrorSource = "reviewer"` and `workerError`, then route to `agent_execution_failed`. Unexpected application errors throw normally.

Before and after every Hermes call, compute the Git-visible worktree fingerprint. If planner, research, or reviewer execution persistently changes tracked or non-ignored untracked content, fail immediately as a boundary violation and expose the before/after diff. This does not prove Hermes never touched ignored files or performed an external side effect. Do not offer resume, because a no-write worker violated its core contract.

### Human checkpoint

**Owner:** LangGraph

Call `interrupt()` with a JSON-serializable payload. Allowed responses depend on the interrupt reason; do not expose one generic approval action.

```json
{
  "run_id": "run identifier",
  "reason": "Why human input is required",
  "task": "Original task",
  "attempt": 3,
  "validation_summary": "Relevant failures",
  "review_summary": "Relevant review findings",
  "allowed_responses": [
    "approve",
    "revise",
    "abort"
  ]
}
```

Use these response sets:

| Interrupt reason | Allowed responses | Outcome |
| --- | --- | --- |
| `review_uncertain` | `approve`, `revise`, `abort` | Approve completes normally; revise returns to Codex; abort stops. |
| `review_changes_exhausted` | `accept_with_review_findings`, `revise`, `abort` | Acceptance completes as `completed_with_override`; revise grants exactly one additional Codex attempt. |
| `validation_failed_exhausted` | `accept_with_failed_validation`, `revise`, `abort` | Acceptance completes as `completed_with_override`; revise grants exactly one additional Codex attempt. |
| `validation_environment_failed` | `retry`, `abort` | Retry reruns validation without spending a Codex attempt. |
| `validation_commands_missing` | `provide_validation`, `abort` | Continue only after caller-supplied trusted commands are provided. |
| `agent_execution_failed` | `retry`, `abort` | Retry re-enters the failed Hermes worker; approval is unavailable. |
| `codex_execution_failed` | `retry`, `abort` | Retry grants exactly one additional Codex attempt; approval is unavailable. |
| `operator_pause` | `continue`, `revise`, `abort` | Continue enters the already-selected next node; revise routes to Codex with guidance. |

`accept_with_failed_validation` and `accept_with_review_findings` require a human message acknowledging the known failures, while `revise` requires nonempty corrective guidance for Codex. Append accepted failure reasons to `overrideReasons`; neither override response can produce ordinary `completed` status. For an exhausted validation, review, or Codex failure, a human retry/revise sets `maxAttempts = attempt + 1`; later exhaustion interrupts again. Retrying a failed Hermes worker does not alter the Codex attempt limit. Human approval must be explicit and reason-appropriate. Keep external side effects in separate nodes because an interrupted node restarts from its beginning when resumed.

### Complete

Produce a structured summary with status, run ID, attempts, workflow-only Git-visible changed files, validation results, review decision, override reasons, and remaining concerns. Preserve `completed_with_override` when the human explicitly accepts failed validation or unresolved review findings, include the evidence and acknowledgement, and never label that outcome as an ordinary success. Derive changes from the workspace's private baseline, checkpoint the terminal state, reconcile the checked patch into the source, then remove the repository lease. Do not commit or push.

### Failed

Preserve the run ID, source and workspace paths, Git baseline, attempt count, worker error, validation failures, review feedback, human response, current workflow-only diff, checkpoint identifier, boundary evidence, and stop reason. Checkpoint the terminal state, remove the repository lease, and preserve an unreconciled workspace. The failed run remains inspectable through its run ID.

## Routing rules

Routing functions are pure and deterministic.

```text
START → planner

planner
  ├── boundary violation → failed
  ├── expected worker failure → human_checkpoint
  ├── no trusted validation commands → human_checkpoint
  ├── research_required and research_mode is auto → research
  └── otherwise → coder

research
  ├── boundary violation → failed
  ├── expected worker failure → human_checkpoint
  └── success → coder

coder
  ├── boundary violation → failed
  ├── exit 0 → validation
  ├── nonzero, attempts remain → coder
  └── nonzero, attempts exhausted → human_checkpoint

validation
  ├── boundary violation → failed
  ├── failed, attempts remain → coder
  ├── failed, attempts exhausted → human_checkpoint
  ├── passed, review required → reviewer
  └── passed, no review → complete

reviewer
  ├── boundary violation → failed
  ├── expected worker failure → human_checkpoint
  ├── approved → complete
  ├── changes requested, attempts remain → coder
  ├── changes requested, attempts exhausted → human_checkpoint
  └── human required → human_checkpoint

human_checkpoint
  ├── approve → complete
  ├── revise → coder
  ├── accept_with_failed_validation → complete with override status
  ├── accept_with_review_findings → complete with override status
  ├── provide_validation → research only when still required and research_mode is auto; otherwise coder
  ├── retry agent execution → planner, research, or reviewer
  ├── retry Codex execution → coder
  └── abort → failed

complete → END
failed → END
```

The graph owns attempt counters. Hermes and Codex may see the current attempt, but neither can increase the maximum or select a transition.

## Graph definition

Keep the graph explicit:

```typescript
builder.addEdge(START, "planner");

builder.addConditionalEdges("planner", routeAfterPlanning, {
  research: "research",
  coder: "coder",
  human: "prepare_human_checkpoint",
  failed: "failed",
});

builder.addConditionalEdges("research", routeAfterResearch, {
  coder: "coder",
  human: "prepare_human_checkpoint",
  failed: "failed",
});

builder.addConditionalEdges("coder", routeAfterCoder, {
  validation: "validation",
  coder: "coder",
  human: "prepare_human_checkpoint",
  failed: "failed",
});

builder.addConditionalEdges("validation", routeAfterValidation, {
  coder: "coder",
  reviewer: "reviewer",
  human: "prepare_human_checkpoint",
  complete: "complete",
  failed: "failed",
});

builder.addConditionalEdges("reviewer", routeAfterReview, {
  coder: "coder",
  human: "prepare_human_checkpoint",
  complete: "complete",
  failed: "failed",
});

builder.addConditionalEdges("prepare_human_checkpoint", routeAfterPausePreparation, {
  human: "human_checkpoint",
  failed: "failed",
});

builder.addConditionalEdges("human_checkpoint", routeAfterHuman, {
  planner: "planner",
  research: "research",
  coder: "coder",
  reviewer: "reviewer",
  complete: "complete",
  complete_override: "complete",
  failed: "failed",
});

builder.addEdge("complete", END);
builder.addEdge("failed", END);
```

## Checkpointing

Use `SqliteSaver` from `@langchain/langgraph-checkpoint-sqlite`, which is intended for lightweight local workflows. Store the database at:

```text
<data_root>/checkpoints.sqlite3
```

Use the stable run ID as LangGraph's thread ID:

```typescript
const config = { configurable: { thread_id: runId } };
```

The checkpointer is authoritative for state, pending nodes, interrupts, and resume behavior. Do not duplicate execution position in `WorkflowState`. The status command reports pending nodes from `(await graph.getState(config)).next`, plus the checkpoint count and latest checkpoint ID. It does not infer completed nodes from `StateSnapshot.next`, because that tuple identifies scheduled work rather than proven completion. The internal `prepare_human_checkpoint` node persists waiting status, changed files, and the pause fingerprint before `human_checkpoint` calls `interrupt()`, because an interrupted node cannot checkpoint its return value before stopping.

Because Codex edits the workspace outside the SQLite checkpoint transaction, a process crash after an edit but before the next checkpoint may cause the coder node to run again. Resume reacquires the global lock, validates the source-keyed repository lease, confirms the workspace HEAD, verifies the pause fingerprint when one exists, and lets Codex inspect and continue from partial workflow changes. The private seeded index makes Git-visible workflow changes attributable to the run; ignored files remain outside that guarantee and the workflow never resets either category automatically.

Keep checkpointed state restricted to the validated primitive values and plain objects defined by `WorkflowState`; do not checkpoint class instances, subprocess handles, errors, or opaque library objects.

## CLI

Expose one local command:

```bash
agent-workflow
```

Required commands are `run`, `status`, and `resume`. `agent-workflow --help` prints their complete command-line surface and exits successfully without opening checkpoints or invoking workers. `history` and `cancel` may be added later.

### Run

```bash
agent-workflow
```

Print the run ID before invoking the first agent:

```text
Run ID: 019abc...
```

A bare `agent-workflow` starts a new run; `agent-workflow run` remains an explicit alias. A new run resolves the target from `--repo` when supplied and otherwise uses `process.cwd()`. It refuses to reuse an existing ID unless resume is explicit.

When stdin and stdout are terminals, `run` and `resume` render the structured event stream as a local terminal UI by default. A new interactive run prompts for its task when `--task` is omitted; non-interactive runs require the flag instead of waiting for input. `--no-interactive` disables the TUI for explicit structured output, while non-terminal execution stays structured automatically. `p` requests an `operator_pause` after the current graph node, `t` toggles redacted raw output, and the pause accepts continue, corrective guidance, or abort without leaving the process. This is a presentation and control layer over the same graph and checkpointer, not a second workflow runtime.

### Status

```bash
agent-workflow status 019abc...
```

Show current status, pending nodes, checkpoint count, latest checkpoint ID, attempt count, validation summary, review decision, and active human-interrupt reason without executing the graph.

### Resume

```bash
agent-workflow resume 019abc... \
  --response revise \
  --message "Keep the existing API shape and update only the serializer."
```

For a missing-validation interrupt, the caller supplies trusted commands while resuming:

```bash
agent-workflow resume 019abc... \
  --response provide_validation \
  --validate "npm run typecheck" \
  --validate "npm test"
```

Validate that the run is waiting, the source-keyed repository lease belongs to it, the isolated workspace fingerprint still matches, and the response is allowed for that interrupt reason. Then resume the same checkpoint with `Command(resume=...)`. Do not restart planning unless explicitly requested.

## Configuration

Prefer CLI options. The only repository configuration file in version one is an optional, Git-tracked `.agent-workflow.json` at the target repository root, parsed with `JSON.parse()` and validated with Zod:

```json
{
  "max_attempts": 3,
  "review_required": true,
  "research_mode": "auto",
  "hermes_timeout_seconds": 1800,
  "codex_timeout_seconds": 3600,
  "validation_timeout_seconds": 1800,
  "validation_commands": [
    "npm run typecheck",
    "npm test"
  ]
}
```

Repeated `--validate` flags replace the JSON validation list. A non-empty JSON validation list overrides automatic tracked-`AGENTS.md` selection. Other CLI flags override matching JSON values. Reject an untracked, symlinked, malformed, or out-of-root configuration file. Do not discover package scripts or build a configuration framework.

The workflow installation may contain a Git-ignored project-root `.env` with `HERMES_PATH` and `CODEX_PATH`. The Bun shebang disables automatic `.env` loading, and the CLI explicitly parses only this installation file before running a command; already exported variables take precedence, and missing values fall back to `hermes` and `codex` on `PATH`. [`.env.example`](../.env.example) documents the two supported variables. Target-repository environment files are never loaded.

## Hermes integration and memory policy

After the CLI works independently, create one Hermes skill that teaches when to start it. Hermes should use the workflow for multi-file repository changes, work needing deterministic validation or retries, changes where independent review adds value, and work that should survive interruption.

Hermes should handle simple questions, research-only tasks, one-line edits, small deterministic changes, tasks without a repository, and tasks without meaningful validation directly.

Once started, LangGraph owns the run. Hermes may report status but must not imitate transitions or treat its own memory as current execution state.

Hermes memory may supply user preferences, repository conventions, prior architectural decisions, and reusable domain knowledge. Current attempt, pending node, test output, approval state, retry count, validation result, and run status belong only in LangGraph state.

## Security boundaries

The workflow may read the selected repository, create and modify an isolated worktree under its user-level data root, run explicitly trusted validation commands there, call Hermes and Codex, inspect Git state, and apply a checked workflow-only patch back to the selected repository. It also writes checkpoint, lock, lease, workspace, and private-index data under its user-level data root.

The workflow is not a hardened credential-isolation boundary. It disables Codex shell network access and web search, retains Codex sandboxing, and does not intentionally expose credentials. Hermes and trusted validation commands remain local processes operating under the invoking user's account.

It may not intentionally deploy, push, merge, open pull requests, modify files outside the selected repository and user-level runtime-data directory, run destructive database commands, install global packages, increase retry limits automatically, disable Codex's sandbox, or execute unreviewed model-generated commands.

Resolve repository paths, require an existing Git worktree, and reject nonexistent paths. Execute validation only from caller-supplied `--validate` values, the checked-in root `.agent-workflow.json`, or planner selections that exactly match eligible commands in checked-in root `AGENTS.md`. Do not log tokens, API keys, full environments, sensitive memory, or credentials found in command output.

Hermes planner, research, and reviewer no-write behavior is a role contract in the MVP, not an OS-enforced sandbox: scripted Hermes runs use the invoking user's normal tools, skills, and permissions. Keep prompts explicit and fingerprint Git-visible state before and after each Hermes call. A detected persistent Git-visible mutation fails the run immediately and exposes the diff; it has no resume action. Ignored-file writes and external side effects are outside this check. Add OS-level isolation only if this limitation proves unacceptable in real use.

## Failure handling and timeouts

### Hermes failure

Planner, research, and reviewer nodes catch expected CLI exits, missing executables, timeouts, and structured-output parsing failures. Store `workerErrorSource` and `workerError`, then route to `agent_execution_failed` with only `retry` or `abort`. Never guess routing fields. Unexpected application errors throw normally and retain the last successful checkpoint.

### Codex failure

Capture the exit code, stdout, stderr, timeout, attempt, and repository diff. A nonzero exit retries Codex while attempts remain and routes to `codex_execution_failed` at exhaustion; validation does not run. Expected failures populate the worker-error fields. Unexpected application errors throw normally.

### Boundary violation

A changed HEAD, changed branch, or detected persistent Git-visible Hermes mutation is not a recoverable worker failure. Set terminal status to `failed`, preserve the diff and invariant evidence, and do not expose a resume action.

### Validation timeout

Spawn each worker or validation command in its own Unix process group. On timeout, send `SIGTERM` to the group, escalate to `SIGKILL` after the grace period, and clear the delayed kill when the group exits. On CLI `SIGINT` or `SIGTERM`, terminate the active group, stop the TUI, release the running repository lease, and preserve the checkpoint and isolated workspace before exiting with the conventional signal code. Mark a timed-out command failed and send its details to Codex on the next allowed attempt.

### Retry exhaustion

Pause for a human; never extend the limit silently.

Initial defaults:

```text
Hermes node: 30 minutes
Codex node: 60 minutes
Validation command: 30 minutes
Human interrupt: no automatic timeout
```

## Logging

Write structured JSON events through one small logging helper. Without a TUI they go to stderr; the TUI consumes the same objects in process. Record run ID, node start and completion, duration, selected transition, attempt, subprocess exit status, interrupt creation, resume action, and terminal status. `--verbose` adds redacted worker command metadata, ten-second heartbeats, and completion, while `--trace` also includes redacted stdout and stderr. Hermes one-shot mode exposes only its final response, so the workflow cannot stream Hermes-internal tool calls. Redact likely secrets from captured output before writing logs or checkpoints.

The first version does not require LangSmith.

## Testing strategy

### Unit tests

Test pure routing functions for research decisions, deterministic review escalation, Codex exit handling, validation retry, environment pause, and exhaustion, optional review, all three review decisions, every interrupt reason, worker retry targets, boundary violations, and the `completed_with_override` outcome.

### Command-wrapper tests

Mock subprocess execution and cover successful and failed Hermes/Codex calls, usable output with nonzero exit, malformed output, timeouts, missing executables, invalid repositories, dirty-worktree isolation, detached-HEAD refusal, HEAD invariants, explicit Codex network/search overrides, validation source selection and shell invocation, and output truncation.

### Graph tests

Compile with fake workers and verify node order, worker-error routing, attempt increments, checkpoint persistence, interrupt behavior, operator guidance, environment-failure retry, correct resume routing, and that completed nodes are not unnecessarily rerun. Verify status reports pending positions, checkpoint count, latest checkpoint ID, source and workspace paths, workflow-only changes, and reconciliation state without treating scheduled nodes as completed. Verify a second `run` or `resume` fails while the global lock is held, a paused leased repository rejects another run, a dead running lease is reclaimed, a mismatched workspace fingerprint refuses resume, signal and terminal outcomes remove the lease, successful reconciliation applies only workflow changes, and conflicting reconciliation preserves the workspace.

### Manual integration test

Use a disposable Git repository with this task:

```text
Add a function that returns the sum of two integers and add tests.
```

Validate with `bun run test`. Confirm a dirty named-branch repository runs in isolation while detached HEAD is refused, runtime files and the worktree stay outside the source repository, Hermes plans without persistent Git-visible changes, Codex shell network and web search are disabled, workspace HEAD remains fixed, validation executes in the workspace, review runs only when required, pause creates a source-keyed lease and workspace fingerprint, state persists through Bun-native SQLite, status is inspectable, an unchanged workspace resumes, and successful reconciliation applies only the workflow delta.

## Implementation phases

### Phase 1: Command wrappers — implemented

`runHermes()`, `runCodex()`, and `runValidationCommand()` use Bun's Node-compatible `node:child_process` implementation with timeouts, bounded captured output, structured errors, named-branch preflight, isolated-worktree execution, Git-visible fingerprinting, Git invariant checks, and explicit Codex network/search overrides. Startup feature-detects the required real CLI flags, while automated tests use controlled fakes.

### Phase 2: Minimal graph — implemented

The `planner → coder → validation` path uses typed worker-error state, conditional routing after both workers, maximum-attempt enforcement, and terminal states. A passing task completes, a Codex failure retries without validation, and exhaustion interrupts.

### Phase 3: SQLite checkpoints — implemented

The XDG-aware user data root contains `SqliteSaver`, stable run IDs, the global `run`/`resume` lock, persistent repository leases, and pause fingerprints. Status inspection and tests reopen checkpoints across process lifetimes.

### Phase 4: Conditional research and review — implemented

Planner decisions, deterministic review-risk escalation, research, review, and routing are implemented. Tests prove simple tasks skip research, low-risk tasks can skip review, and planner output cannot suppress review for a trusted risk rule.

### Phase 5: Human interrupt and resume — implemented

`interrupt()`, reason-specific response payloads, `completed_with_override`, resume-time validation input, and revision routing are implemented on the same checkpoint thread.

### Phase 6: Hermes skill — implemented

The repository-local `agent-workflow` skill decides when the workflow is appropriate, starts it, reports the run ID, checks status before restarting, and preserves exact repository scope. It does not generate graphs or manage state manually.

### Phase 7: Compact output and terminal steering — implemented

Validation preserves the selected runtime, environment failures pause before another coding attempt, and model prompts receive bounded diagnostics. The dependency-free TUI renders the shared event stream and requests checkpointed pauses only at safe graph-node boundaries.

## Initial acceptance criteria

The first usable release satisfies these criteria:

- LangGraph owns every transition and retry limit.
- Hermes plans and optionally researches or reviews without becoming workflow state.
- Codex is invoked directly with workspace sandboxing retained.
- Codex failures route deterministically and never fall through to validation.
- Validation uses trusted deterministic commands and exit codes.
- Validation commands come only from repeated caller flags, checked-in root JSON, or exact eligible matches in checked-in root `AGENTS.md`; undocumented Hermes output never executes.
- Validation or review feedback loops back to Codex only while attempts remain.
- Deterministic risk rules can require review even when Hermes does not.
- SQLite checkpoints every run under a stable ID.
- Checkpoints, the process lock, and repository leases live under the XDG-aware user data root, never a target repository.
- Status works without executing nodes.
- Status derives execution position from LangGraph checkpoints rather than duplicated state.
- Human input can pause and resume the same checkpoint.
- Failed validation can finish only through explicit `completed_with_override` semantics.
- Every reachable recoverable worker failure has an explicit interrupt reason and response set.
- A new run accepts dirty tracked and non-ignored untracked source state, seeds it into an isolated worktree, and never resets or cleans user changes.
- A new run refuses detached HEAD and records a named active branch.
- The isolated workspace HEAD remains unchanged; changed files are derived from its private seeded baseline.
- Changed-file reporting covers Git-visible files and non-ignored untracked additions; ignored files are explicitly outside the guarantee.
- Successful terminal reconciliation applies only the workflow delta after `git apply --check`; a conflict preserves the workspace and source state.
- Hermes persistent Git-visible mutation or a Git invariant violation fails immediately without resume.
- One global process lock prevents concurrent `run` and `resume` writers.
- A persistent repository lease prevents another run from claiming a paused run's source repository, while dead running leases are reclaimed automatically.
- Resume refuses a changed workspace fingerprint and retains the paused lease for manual reconciliation.
- Codex runs with shell network access and web search explicitly disabled.
- No server or external infrastructure is required.
- The implementation remains understandable by one developer in one sitting.

## Future enhancements

Add only after actual usage justifies them:

- GitHub issue input or explicitly approved pull-request creation;
- multiple fixed workflow templates;
- Postgres checkpoints for concurrency;
- LangSmith tracing;
- parallel research;
- specialist security or documentation review nodes;
- repository-specific workflow configuration; or
- MCP exposure for clients other than Hermes.

## Final architecture

```text
User
  ↓
Hermes
  ├── Handles simple tasks directly
  └── Starts agent-workflow for structured repository work
                ↓
          LangGraph Runtime
          ├── Planner → Hermes
          ├── Research → Hermes or deterministic tool
          ├── Coder → Codex CLI
          ├── Validation → trusted commands
          ├── Reviewer → Hermes
          ├── Human checkpoint → LangGraph interrupt
          └── Complete or Failed
                ↓
          SQLite Checkpointer
```

LangGraph owns the workflow. Hermes supplies reasoning where reasoning is useful. Codex writes the code. Deterministic tools validate it. Human input is requested only when automation cannot safely decide.

## Authoritative references

- [LangGraph JavaScript persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph JavaScript interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [LangGraph.js SQLite checkpointer](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex configuration reference](https://learn.chatgpt.com/codex/config-file/config-reference)
- [Hermes CLI command reference](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)
