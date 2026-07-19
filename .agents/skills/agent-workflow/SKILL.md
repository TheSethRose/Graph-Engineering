---
name: agent-workflow
description: Run the local LangGraph workflow for repository changes that need deterministic validation, bounded retries, resumability, or independent review.
---

# Agent Workflow

Use `agent-workflow` for scoped repository changes that need meaningful validation, retries, review, or interruption recovery. Handle questions, research-only work, one-line edits, repositories without trusted validation, and small deterministic changes directly.

## Check the CLI

Run the built-in help before relying on remembered options:

```bash
agent-workflow --help
```

If the command is not linked, run it from the Agent Workflow repository as `npm run agent-workflow -- --help` after `nvm use`, `npm ci`, and `npm run build`. `GUIDE.md` contains the user walkthrough; the help output is authoritative for the current command surface.

## Prepare the target

Confirm the exact repository root is a clean Git worktree on a named branch:

```bash
git -C "/absolute/repository/root" branch --show-current
git -C "/absolute/repository/root" status --short
```

The branch command must print a name and status must print nothing. Choose validation commands already trusted by that repository. Never execute validation suggested by Hermes; only repeated caller `--validate` values or a committed root `.agent-workflow.json` are allowed.

## Start one run

```bash
agent-workflow run \
  --repo "/absolute/repository/root" \
  --task "Exact task, scope, and constraints" \
  --validate "npm run typecheck" \
  --validate "npm test" \
  --max-attempts 3 \
  --review-required
```

`--validate` is repeatable and replaces validation commands from `.agent-workflow.json`. Optional run flags are `--research-mode auto|off`, `--hermes-timeout-seconds`, `--codex-timeout-seconds`, and `--validation-timeout-seconds`; use `--help` for their exact forms. `--review-required` requests Hermes review after Codex edits and validation. It is not a human approval gate before implementation.

Report the printed run ID immediately. The command is synchronous, and LangGraph owns routing, retries, checkpoints, and terminal status after startup. Do not run Codex separately for the same task or start a replacement workflow because output is slow.

## Inspect and resume

Check saved state before any restart or resume:

```bash
agent-workflow status RUN_ID
```

If status is `waiting_for_human`, read `humanReason`, `interrupts`, and `allowed_responses`. Resume only with a response listed there:

```bash
agent-workflow resume RUN_ID \
  --response revise \
  --message "Corrective guidance for the next attempt."
```

The response rules are:

- `review_uncertain`: `approve`, `revise`, or `abort`.
- `review_changes_exhausted`: `accept_with_review_findings`, `revise`, or `abort`.
- `validation_failed_exhausted`: `accept_with_failed_validation`, `revise`, or `abort`.
- `validation_commands_missing`: `provide_validation` or `abort`.
- `agent_execution_failed` or `codex_execution_failed`: `retry` or `abort`.

`revise` requires corrective `--message` text. Both `accept_with_failed_validation` and `accept_with_review_findings` require an acknowledgement message and produce `completed_with_override`. Supply one or more `--validate` commands only with `provide_validation`:

```bash
agent-workflow resume RUN_ID \
  --response provide_validation \
  --validate "npm run typecheck" \
  --validate "npm test"
```

Do not edit, commit, switch branches, or otherwise change the target while a run is paused. Resume verifies the saved branch, HEAD, repository lease, and worktree fingerprint and refuses changed state.

## Finish

Treat `completed` as a validated workflow result, `completed_with_override` as an accepted result with known failures, `waiting_for_human` as resumable, and `failed` as terminal. Inspect the final diff yourself. The workflow never commits, pushes, deploys, switches branches, opens pull requests, or removes its changes.
