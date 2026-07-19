# Hermes + Codex Agentic Graph Workflow

A local development workflow that gives each component one job:

- LangGraph routes and checkpoints the run.
- Hermes plans, researches when needed, and reviews.
- Codex edits the selected repository directly.
- Trusted project commands decide whether the change passes.
- SQLite makes a run inspectable and resumable.

![Graph Engineering workflow overview](docs/graph-engineering-infographic.png)

The first release is implemented in strict TypeScript on Node.js 24. The [implementation plan](docs/PLAN.md) is the execution contract, and the [architecture research](docs/RESEARCH.md) records the technical basis and known constraints.

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
nvm use
npm ci
npm run build
npm test
npm link
```

`npm link` exposes `agent-workflow` on the current user's path. Without linking, replace `agent-workflow` below with `npm run agent-workflow --`.

The CLI loads executable paths from the project-root `.env` using Node's built-in environment-file parser. Start from [`.env.example`](.env.example), use absolute paths, and leave either variable unset to fall back to the normal `PATH` lookup:

```dotenv
HERMES_PATH=/absolute/path/to/hermes
CODEX_PATH=/absolute/path/to/codex
```

An already exported `HERMES_PATH` or `CODEX_PATH` takes precedence over the file. The local `.env` is ignored by Git.

## Command surface

```bash
agent-workflow run \
  --repo "/absolute/path/to/repository" \
  --task "Add CSV export for scheduled posts." \
  --validate "npm run typecheck" \
  --validate "npm test" \
  --max-attempts 3

agent-workflow status 019abc...

agent-workflow resume 019abc... \
  --response revise \
  --message "Keep the existing API shape."
```

`run` prints its stable run ID before calling Hermes. `status` reads checkpoints without executing the graph, while `resume` requires a response allowed by the active interrupt and rejects a changed repository fingerprint.

## Boundaries

The initial version is synchronous, single-process, and local to macOS or Unix. It will not provide a server, dashboard, queue, plugin system, dynamic graphs, parallel writers, deployments, commits, pushes, pull requests, or untested Windows support. Runtime state lives under `$XDG_DATA_HOME/agent-workflow` or `~/.local/share/agent-workflow`, never in a target repository.

A new run requires a clean worktree on a named branch, records HEAD and the branch, and refuses to continue if either changes. One global process lock prevents concurrent writers, while a persistent repository lease protects paused runs after that lock is released. Resume also requires the repository's Git-visible fingerprint to match the fingerprint saved at the interrupt.

Git-visible change attribution assumes no editor, terminal, or other automation modifies the target repository while a `run` or `resume` invocation is active. The workflow lock excludes other workflow writers, but reliable attribution against unrelated processes requires future per-run worktree isolation.

Codex retains workspace sandboxing, runs with shell network access and web search explicitly disabled, and is instructed not to perform Git history or branch operations; the workflow enforces that instruction through recorded Git invariants. Validation commands come only from repeated caller `--validate` flags or a checked-in root `.agent-workflow.json`; Hermes suggestions never execute.

This is not a hardened credential-isolation boundary. Hermes and trusted validation commands remain local processes running with the invoking user's permissions.

Codex and Hermes failures have explicit graph routes instead of falling through to the next node. Every recoverable interrupt reason exposes only its valid responses, while a detected persistent Git-visible Hermes mutation or changed HEAD/branch fails immediately. Ignored-file writes and external side effects are outside the fingerprint guarantee. Accepting failed validation or unresolved review findings produces `completed_with_override`, never ordinary successful completion. Run position is derived from LangGraph checkpoint snapshots and history rather than duplicated state.

An unexpected exception caught by the CLI preserves the last checkpoint and worktree but releases that run's repository lease so it cannot strand the repository. A hard process crash may leave a stale entry in `<data_root>/active-runs.json`; after confirming no workflow process is alive and manually reconciling the worktree, remove only that repository's entry before starting another run.

## Prerequisites

- Node.js 24 LTS
- An authenticated Hermes CLI
- An authenticated Codex CLI
- A clean local Git repository to operate on

The workflow uses strict TypeScript with `@langchain/langgraph`, `@langchain/langgraph-checkpoint-sqlite`, and Zod. Node's standard library provides the CLI, subprocess, filesystem, hashing, and test surfaces; there is no server framework, ORM, queue, broad LangChain package, or test framework.

## Implemented components

1. The Hermes, Codex, validation, configuration, and Git wrappers enforce the subprocess and repository boundaries before graph routing sees their results.
2. The fixed LangGraph routes planning, optional research, direct Codex execution, deterministic validation, optional review, bounded retries, terminal outcomes, and every recoverable worker failure.
3. SQLite checkpoints, stable thread IDs, `run`/`status`/`resume`, the global process lock, persistent repository leases, and pause fingerprints provide local recovery without a server.
4. Reason-specific interrupts validate human responses and reserve `completed_with_override` for explicit acceptance of failed validation or unresolved review findings.
5. The repository-local Hermes skill at [`.agents/skills/agent-workflow/SKILL.md`](.agents/skills/agent-workflow/SKILL.md) explains when to start or resume the workflow without taking ownership of its state.

## Verification

`npm test` builds the project and runs focused `node:test` coverage for command failures, strict worker output, Git preflight, trusted validation sources, routing, retry exhaustion, optional review, SQLite persistence, interrupts, resume, override completion, boundary violations, locking, leases, fingerprints, and the compiled CLI.
