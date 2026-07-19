# Using Agent Workflow

Agent Workflow takes a coding task, asks Hermes to plan it, lets Codex edit the chosen repository, and runs commands you trust to check the result. It works on your local files and stops when it needs a decision from you.

Use it for a change that has several steps, needs tests, or may need review and another attempt. For a question or a tiny edit, working directly is usually faster.

## Set it up once

From this repository:

```bash
cd /Users/sethrose/Developer/experiments/graph-engineering
nvm use
npm ci
npm run build
npm link
```

You need Node.js 24 and signed-in `hermes` and `codex` commands. If either command is not on your `PATH`, copy `.env.example` to `.env` and replace the example values with absolute paths:

```dotenv
HERMES_PATH=/absolute/path/to/hermes
CODEX_PATH=/absolute/path/to/codex
```

Confirm that the command is available:

```bash
agent-workflow --help
```

It will print every command, option, and resume response. If you skipped `npm link`, run every example from this repository and replace `agent-workflow` with `npm run agent-workflow --`.

## Prepare the repository you want to change

The target must be a Git repository on a named branch with no uncommitted files. Agent Workflow refuses to start from a dirty worktree because it needs to tell your existing work apart from its own changes.

```bash
cd /absolute/path/to/your/repository
git branch --show-current
git status --short
```

The first command should print a branch name. The second command should print nothing. Commit or stash your work before continuing.

Choose at least one validation command that fits the task. Use commands the repository already trusts, such as its type check, tests, or linter. Run them yourself once if you are not sure they work.

## Start a run

You can start the workflow from any directory because `--repo` names the target:

```bash
agent-workflow run \
  --repo "/absolute/path/to/your/repository" \
  --task "Add CSV export for scheduled posts." \
  --validate "npm run typecheck" \
  --validate "npm test"
```

Write the task as a clear result. Include important limits, such as files that must stay unchanged or an API shape that must remain compatible.

Each `--validate` value is one shell command. The workflow runs them in order from the target repository. These commands execute with your user permissions, so only pass commands you trust.

The command prints a run ID before work begins:

```text
Run ID: 019abc...
```

Save that ID. The run is synchronous, so leave the command open while Hermes, Codex, and validation are working.

## Read the result

The final JSON includes the status, attempt number, changed files, validation results, review result, and any remaining concerns.

- `completed` means the workflow finished and its required checks passed.
- `completed_with_override` means a person accepted failed checks or open review findings. Read `overrideReasons` before keeping the changes.
- `waiting_for_human` means the run is paused for your decision.
- `failed` means the workflow stopped and cannot be resumed from that point.

You can inspect a saved run without starting any work:

```bash
agent-workflow status 019abc...
```

When a run is paused, look at `humanReason`, `interrupts`, and `allowed_responses`. The interrupt also includes the test failure, review notes, or worker error that caused the pause.

## Continue a paused run

Use one of the exact values in `allowed_responses`:

```bash
agent-workflow resume 019abc... \
  --response revise \
  --message "Keep the existing API shape and update only the serializer."
```

The available responses depend on why the run paused:

| Pause reason | Responses |
| --- | --- |
| Review needs your decision | `approve`, `revise`, `abort` |
| Review changes used all attempts | `accept_with_review_findings`, `revise`, `abort` |
| Validation used all attempts | `accept_with_failed_validation`, `revise`, `abort` |
| No validation command was given | `provide_validation`, `abort` |
| Hermes or Codex failed to run | `retry`, `abort` |

To provide missing validation commands:

```bash
agent-workflow resume 019abc... \
  --response provide_validation \
  --validate "npm run typecheck" \
  --validate "npm test"
```

Accepting failed validation or open review findings requires a message that records what you are accepting:

```bash
agent-workflow resume 019abc... \
  --response accept_with_failed_validation \
  --message "The known snapshot failure is unrelated to this change."
```

Do not edit the target repository, switch branches, or make a commit while a run is paused. The workflow checks the branch, commit, and files before resuming. If they changed, it will refuse to continue so it does not overwrite or mislabel your work.

## Review the finished work

Agent Workflow edits files but never commits, pushes, deploys, switches branches, or opens a pull request. After it finishes, inspect the changes and run any final checks you want:

```bash
cd /absolute/path/to/your/repository
git status --short
git diff
```

You remain responsible for deciding whether to keep, commit, or discard the changes.

## Save repeated settings in a repository

If a repository uses the same settings for most runs, add a tracked `.agent-workflow.json` at its root:

```json
{
  "max_attempts": 3,
  "review_required": true,
  "research_mode": "auto",
  "validation_commands": [
    "npm run typecheck",
    "npm test"
  ]
}
```

The file must be committed before the workflow will use it because a new run requires a clean worktree. Commands passed with `--validate` replace the file's validation list for that run.

Useful command-line options include:

- `--max-attempts 3` limits coding and review attempts.
- `--review-required` requests a Hermes review even when the workflow does not require one by risk rules.
- `--research-mode off` skips optional research.
- `--hermes-timeout-seconds`, `--codex-timeout-seconds`, and `--validation-timeout-seconds` set positive timeout values for slow work.

## Common problems

**The worktree is not clean:** Commit or stash existing changes, then start a new run.

**The repository is on a detached HEAD:** Check out a named branch before starting.

**A paused run will not resume:** Run `status`, confirm that your response is allowed, and make sure nobody changed the target repository after it paused.

**The workflow says validation is missing:** Resume with `provide_validation` and at least one trusted `--validate` command.

**The CLI cannot find Hermes or Codex:** Sign in to both tools, then put them on `PATH` or set their absolute paths in this project's `.env`.
