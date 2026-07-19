# Using Agent Workflow

Agent Workflow takes a coding task, asks Hermes to plan it, lets Codex edit the chosen repository, and runs commands you trust to check the result. It works on your local files and stops when it needs a decision from you.

Use it for a change that has several steps, needs tests, or may need review and another attempt. For a question or a tiny edit, working directly is usually faster.

## Set it up once

From this repository:

```bash
cd /Users/sethrose/Developer/experiments/graph-engineering
bun install --frozen-lockfile
bun run build
bun link
```

You need Bun and signed-in `hermes` and `codex` commands. If either agent command is not on your `PATH`, copy `.env.example` to `.env` and replace the example values with absolute paths:

```dotenv
HERMES_PATH=/absolute/path/to/hermes
CODEX_PATH=/absolute/path/to/codex
```

Confirm that the command is available:

```bash
agent-workflow --help
```

It will print every command, option, and resume response. If you skipped `bun link`, run every example from this repository and replace `agent-workflow` with `bun run agent-workflow --`.

## Prepare the repository you want to change

The target must be a Git repository on a named branch with no uncommitted files. Agent Workflow refuses to start from a dirty worktree because it needs to tell your existing work apart from its own changes.

```bash
cd /absolute/path/to/your/repository
git branch --show-current
git status --short
```

The first command should print a branch name. The second command should print nothing. Commit or stash your work before continuing.

Keep the repository's root `AGENTS.md` current, especially its setup, build, test, validation, or check sections. The planner selects applicable commands from those instructions and the workflow accepts only exact documented matches.

## Start a run

Change into the clean repository you want to modify, then run the workflow. The current directory is the target and a terminal opens the TUI automatically:

```bash
cd /absolute/path/to/your/repository
agent-workflow
```

Use `--repo "/another/repository"` only when you intentionally want to target a directory other than the one you are in.

The TUI asks for the task before starting the workflow. Write it as a clear result and include important limits, such as files that must stay unchanged or an API shape that must remain compatible. `--task "..."` skips the prompt when the task is already written and is required with `--no-interactive`. The coding worker is always told to follow applicable `AGENTS.md` files and update them when the completed behavior makes their instructions stale.

Validation runs in order from the target repository with your user permissions. Repeated `--validate` flags remain available when you intentionally need to override both `AGENTS.md` selection and repository configuration.

The command prints a run ID before work begins:

```text
Run ID: 019abc...
```

Save that ID. The run is synchronous, so leave the command open while Hermes, Codex, and validation are working. In the TUI, press `p` to pause after the current graph node. At that safe boundary, press `c` to continue, `g` to type guidance for a new Codex pass, or `a` to abort. Press `t` while running to toggle the redacted raw trace. Hermes one-shot mode returns only its final response, so the TUI can show heartbeats but not Hermes-internal tool calls. Ctrl-C terminates the active worker process group and releases the repository lease without discarding partial edits.

For machine-readable output, use `--no-interactive`; redirected or piped execution also stays structured automatically. `--verbose` adds redacted commands, heartbeats, and completion events to the normal event stream, while `--trace` also includes redacted worker stdout and stderr.

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
| Validation hit a Node ABI or engine mismatch | `retry`, `abort` |
| No applicable validation command was documented | `provide_validation`, `abort` |
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

The file must be committed before the workflow will use it because a new run requires a clean worktree. Its validation list overrides automatic `AGENTS.md` selection, and commands passed with `--validate` replace the file's validation list for that run.

Useful command-line options include:

- `--max-attempts 3` limits coding and review attempts.
- `--review-required` requests a Hermes review even when the workflow does not require one by risk rules.
- `--research-mode off` skips optional research both after planning and after a missing-validation pause resumes.
- `--hermes-timeout-seconds`, `--codex-timeout-seconds`, and `--validation-timeout-seconds` set positive timeout values for slow work.

## Common problems

**The worktree is not clean:** Commit or stash existing changes, then start a new run.

**The repository is on a detached HEAD:** Check out a named branch before starting.

**A paused run will not resume:** Run `status`, confirm that your response is allowed, and make sure nobody changed the target repository after it paused.

**The workflow says validation is missing:** Add commands to a validation-related section of root `AGENTS.md` before the next run, or resume this run with `provide_validation` and at least one trusted `--validate` command.

**Validation reports a runtime mismatch:** Fix the target repository's runtime or dependency installation, then resume with `retry`. This pause does not spend a Codex attempt.

**The CLI cannot find Hermes or Codex:** Sign in to both tools, then put them on `PATH` or set their absolute paths in this project's `.env`.
