# Hermes + Codex Agentic Graph Workflow

A local development workflow that gives each component one job:

- LangGraph routes and checkpoints the run.
- Hermes plans, researches when needed, and reviews.
- Codex edits the selected repository directly.
- Trusted project commands decide whether the change passes.
- SQLite makes a run inspectable and resumable.

![Graph Engineering workflow overview](docs/graph-engineering-infographic.png)

The first release is implemented in strict TypeScript and runs entirely on Bun. The [implementation plan](docs/PLAN.md) is the execution contract, and the [architecture research](docs/RESEARCH.md) records the technical basis and known constraints.

## Workflow

```text
START → Hermes plan
           ├── research required → Hermes or deterministic research ─┐
           └── no research ──────────────────────────────────────────┤
                                                                    ↓
                                                               Codex edits
                                                                    ↓
                                                         trusted validation
                     ┌── failed, attempts remain ────────────────────┘
                     ├── failed, exhausted → human checkpoint
                     ├── passed, review required → Hermes review
                     │                                ├── approved → complete
                     │                                ├── changes requested → Codex
                     │                                └── human required → human checkpoint
                     └── passed, no review → complete
```

LangGraph owns every transition. Agent output is parsed as data; it does not select arbitrary nodes, extend retry limits, or suppress review required by deterministic risk rules.

## Setup

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run doctor
bun run test
bun link
```

`bun link` exposes `agent-workflow` on the current user's path. Without linking, replace `agent-workflow` below with `bun run agent-workflow --`.

The CLI loads executable paths from the project-root `.env` without loading a target repository's environment file. Start from [`.env.example`](.env.example), use absolute paths, and leave either variable unset to fall back to the normal `PATH` lookup:

```dotenv
HERMES_PATH=/absolute/path/to/hermes
CODEX_PATH=/absolute/path/to/codex
```

An already exported `HERMES_PATH` or `CODEX_PATH` takes precedence over the file. The local `.env` is ignored by Git.

## Command surface

```bash
agent-workflow --help

cd "/absolute/path/to/repository"
agent-workflow

agent-workflow status 019abc...

agent-workflow resume 019abc... \
  --response revise \
  --message "Keep the existing API shape."
```

Bare `agent-workflow` starts a run in the current directory and prompts for the task in the TUI; `agent-workflow run` remains an explicit alias. `--task "..."` is available for scripts or when the task is already written, and `--repo` can target another path. Press `p` to pause after the active graph node, then continue, add corrective guidance, or abort; press `t` to toggle raw redacted output. Use `--no-interactive` for structured output, which requires `--task`; `--verbose` adds command progress and heartbeats, while `--trace` includes redacted stdout and stderr. Hermes one-shot mode exposes only its final response, not internal tool calls. `status` reads checkpoints without executing the graph, while `resume` requires a response allowed by the active interrupt and rejects a changed repository fingerprint.

`--research-mode off` suppresses optional Hermes research. A planner research request then routes directly to Codex, including when a missing-validation pause resumes after the caller provides trusted commands.

## Boundaries

The initial version is synchronous, single-process, and local to macOS or Unix. Its optional TUI is only a view and control surface over the same in-process graph; there is no server, web dashboard, queue, plugin system, dynamic graph, or parallel writer. Runtime state lives under `$XDG_DATA_HOME/agent-workflow` or `~/.local/share/agent-workflow`, never in a target repository.

A new run requires a clean worktree on a named branch, records HEAD and the branch, and refuses to continue if either changes. One global process lock prevents concurrent writers, while a persistent repository lease protects paused runs after that lock is released. Resume also requires the repository's Git-visible fingerprint to match the fingerprint saved at the interrupt.

Git-visible change attribution assumes no editor, terminal, or other automation modifies the target repository while a `run` or `resume` invocation is active. The workflow lock excludes other workflow writers, but reliable attribution against unrelated processes requires future per-run worktree isolation.

Codex retains workspace sandboxing, runs with shell network access and web search explicitly disabled, and is instructed not to perform Git history or branch operations; the workflow enforces that instruction through recorded Git invariants. By default, Hermes selects validation commands by copying them exactly from setup, build, test, validation, or check sections of a checked-in root `AGENTS.md`. The workflow executes only exact matches; repeated caller `--validate` flags or a checked-in root `.agent-workflow.json` remain explicit overrides.

This is not a hardened credential-isolation boundary. Hermes and trusted validation commands remain local processes running with the invoking user's permissions.

Codex and Hermes failures have explicit graph routes instead of falling through to the next node. Every recoverable interrupt reason exposes only its valid responses, while a detected persistent Git-visible Hermes mutation or changed HEAD/branch fails immediately. Ignored-file writes and external side effects are outside the fingerprint guarantee. Accepting failed validation or unresolved review findings produces `completed_with_override`, never ordinary successful completion. Run position is derived from LangGraph checkpoint snapshots and history rather than duplicated state.

Validation inherits the workflow environment through `/bin/sh -c`. High-confidence runtime failures such as a native Node ABI or package-engine mismatch in a target repository pause as `validation_environment_failed` without consuming another Codex attempt. Complete command output remains checkpointed within the normal capture limit, while model retry and review prompts receive a bounded diagnostic excerpt.

Ctrl-C terminates the active worker process group, preserves the last checkpoint and worktree, and releases that run's repository lease. An unexpected exception caught by the CLI has the same preservation and lease cleanup behavior. A hard process crash may leave a stale entry in `<data_root>/active-runs.json`; after confirming no workflow process is alive and manually reconciling the worktree, remove only that repository's entry before starting another run.

## Prerequisites

- Bun 1.3 or newer
- An authenticated Hermes CLI
- An authenticated Codex CLI
- A clean local Git repository to operate on

The workflow uses strict TypeScript with the required `@langchain/core` peer, `@langchain/langgraph`, `@langchain/langgraph-checkpoint-sqlite`, and Zod. Bun provides the runtime, test runner, and native SQLite driver; its Node-compatible standard library provides subprocess, filesystem, and hashing APIs. A small local compatibility package maps the official LangGraph saver's `better-sqlite3` surface to `bun:sqlite`, so checkpoint behavior remains upstream-owned.

## Implemented components

1. The Hermes, Codex, validation, configuration, and Git wrappers enforce the subprocess and repository boundaries before graph routing sees their results.
2. The fixed LangGraph routes planning, optional research, direct Codex execution, deterministic validation, optional review, bounded retries, terminal outcomes, and every recoverable worker failure.
3. SQLite checkpoints, stable thread IDs, `run`/`status`/`resume`, the global process lock, persistent repository leases, and pause fingerprints provide local recovery without a server.
4. Reason-specific interrupts validate human responses and reserve `completed_with_override` for explicit acceptance of failed validation or unresolved review findings.
5. The repository-local Hermes skill at [`.agents/skills/agent-workflow/SKILL.md`](.agents/skills/agent-workflow/SKILL.md) explains when to start or resume the workflow without taking ownership of its state.

## Verification

`bun run typecheck` and `bun run lint` enforce the TypeScript and ESLint contracts. `bun run doctor` runs its configured tooling and supply-chain checks; this repository is not a React project, so React-only rules are expected to report as gated rather than applicable. `bun run test` builds the project and runs focused `bun:test` coverage for command failures, strict worker output, Git preflight, trusted validation sources, routing, retry exhaustion, optional review, SQLite persistence, interrupts, resume, override completion, boundary violations, locking, leases, fingerprints, and the compiled CLI.
