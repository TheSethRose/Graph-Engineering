# Architecture Research

## Conclusion

The implemented division of responsibility is sound for a small local workflow. LangGraph provides explicit state graphs, checkpoint threads, conditional routing, and resumable interrupts, so the implementation does not duplicate those orchestration features. Hermes and Codex both expose non-interactive CLI surfaces, which keeps model access and authentication outside the TypeScript process. SQLite is intentionally local and limited, but that limitation matches the first version's one-run-at-a-time boundary.

The largest unresolved risk is enforcement of Hermes's read-only planner, researcher, and reviewer roles. Scripted Hermes uses the invoking user's normal tools and permissions, and its CLI does not expose a documented read-only filesystem sandbox. The MVP fingerprints persistent Git-visible state around every Hermes call and fails immediately on a detected mutation, but ignored-file writes and external side effects remain outside that check.

## Required command surfaces

- Hermes Agent must support `hermes -z PROMPT`, which returns the final response for scripts and pipes.
- Hermes can select toolsets per invocation, although its `file` and `terminal` toolsets are not documented as read-only.
- Codex CLI must support `codex exec`, `--cd`, `--sandbox workspace-write`, `--ask-for-approval never`, `--output-schema`, and `--output-last-message`.
- Codex also exposes `--dangerously-bypass-approvals-and-sandbox`; this workflow must never use it because the parent process is not an external security sandbox. `workspace-write` constrains access but does not semantically prohibit commits, resets, cleans, or branch changes, so those require independent Git checks. Inline overrides explicitly set `sandbox_workspace_write.network_access=false` and `web_search="disabled"` rather than trusting user defaults.

The implementation checks for required executables and flags at startup and returns a clear compatibility error rather than depending on specific CLI versions.

## Why TypeScript and Bun fit

LangGraph's JavaScript implementation provides the graph, persistence, interrupt, `thread_id`, state-inspection, and `Command({ resume })` behavior required by this workflow. The official `@langchain/langgraph-checkpoint-sqlite` package supplies the local checkpointer, so the architecture does not depend on Python-only functionality.

Strict TypeScript plus Zod makes worker output, checkpoint state, route decisions, and human responses explicit at both compile time and runtime. That matters more here than Python's smaller standard-library dependency count because malformed agent output is a routing failure, not a value the workflow may coerce or guess.

Bun provides the CLI runtime, test runner, and native SQLite driver while supporting the Node standard-library APIs used for subprocesses, files, paths, hashing, and signals. Version one remains explicitly macOS/Unix because validation uses `/bin/sh` and the process-lock recovery contract must be tested per operating system.

## Why LangGraph owns orchestration

LangGraph checkpoints state after graph steps and groups checkpoint history by `thread_id`. Its persistence model supports state inspection, fault recovery, and human-in-the-loop execution without adding a server. Conditional edges keep retry and review routing deterministic, while node functions remain ordinary TypeScript.

Interrupts call `interrupt()` with a JSON-serializable value and resume with `Command(resume=...)` on the same thread. LangGraph restarts the interrupted node from its beginning, so side effects must occur in separate nodes or be idempotent. The plan follows that rule by making human interaction its own node and keeping Codex execution outside it.

This is enough for the stated workflow. LangGraph Platform, LangSmith, supervisors, swarms, and prebuilt agents do not add necessary capability to the first version.

## Why SQLite fits

The official JavaScript persistence documentation describes `@langchain/langgraph-checkpoint-sqlite` as a SQLite checkpointer suited to experimentation and local workflows. That package imports `better-sqlite3`, while Bun provides a similar synchronous API through `bun:sqlite`. A local compatibility package supplies the two behaviors the official saver assumes but Bun expresses differently: `pragma()` and an `undefined` no-row result from prepared `get()`. LangGraph still owns every query, schema, serialization rule, and checkpoint method, so this avoids a local checkpointer fork.

SQLite, the process lock, and repository leases belong in an XDG-aware user data directory outside this project and every target repository. A stable run ID becomes the LangGraph `thread_id`, while a small atomic `active-runs.json` mapping preserves repository ownership across pauses without another database service.

Checkpoint data remains a trust boundary even locally. State should contain only primitives and plain objects accepted by the Zod-backed state schema; class instances, subprocess handles, errors, credentials, and opaque library objects do not belong in checkpoints.

## Subprocess boundary

Hermes and Codex share one small subprocess runner built on Bun's Node-compatible `node:child_process.spawn()`, with an explicit cwd, argument array, timeout, captured UTF-8 text, and no shell. Each invocation gets its own Unix process group so timeout termination reaches descendants rather than only the immediate CLI or shell process. A common `CommandResult` avoids incompatible error formats without introducing an abstraction hierarchy. The Bun shebang disables automatic environment-file loading, then the workflow explicitly parses only its own project-root `.env` for `HERMES_PATH` and `CODEX_PATH`; target-repository environment files are not loaded.

Codex receives its prompt as a normal argument, runs in the target repository with `workspace-write`, and returns a schema-validated final message. Hermes returns strict JSON for planning and review. Model output is untrusted input: missing keys, invalid decisions, or suggested commands are rejected rather than repaired heuristically. Planner review advice can escalate review but cannot suppress deterministic review rules for authentication, security, migrations, or public contracts.

Validation commands are a separate trusted-code boundary. Repeated caller `--validate` flags take precedence, followed by a Git-tracked `.agent-workflow.json`. Without either override, the planner may select commands only by copying exact inline or shell-fenced commands from setup, build, test, validation, or check sections of a Git-tracked root `AGENTS.md`; negated instructions and commands from unrelated sections are excluded. Run accepted commands sequentially through `/bin/sh -c`. Package scripts already execute arbitrary repository code, so exact matching against tracked instructions creates the useful model-output boundary without inventing a partial shell parser.

## State and repository consistency

LangGraph can transactionally checkpoint its own state, but it cannot make a Codex worktree edit atomic with SQLite. Version one therefore requires a clean worktree on a named branch, records HEAD and branch, and attributes later Git-visible changes to the run. That attribution assumes no editor, terminal, or external automation changes the repository during an active invocation; reliable multi-writer attribution requires per-run worktree isolation. A crash after Codex writes files and before the next checkpoint may cause Codex to run again on resume; Codex inspects those partial workflow changes and the orchestrator never resets them.

This limitation also means status must distinguish checkpoint state from repository state. Pending nodes come directly from `graph.getState()`, while checkpoint count and the latest checkpoint ID describe persisted progress without mislabeling scheduled nodes as completed. Porcelain status against the clean baseline reports Git-visible workflow changes and non-ignored untracked additions. Ignored files are outside attribution. A duplicate `lastCompletedNode` state field would drift and is unnecessary. Dirty-worktree support waits for worktree isolation.

The process lock cannot remain held across an indefinite interrupt. A persistent canonical-repository lease blocks a second run, while a pause-time fingerprint over HEAD, branch, tracked diff, and non-ignored untracked content detects Git-visible changes before resume. A mismatch refuses resume and leaves reconciliation to the user.

Expected worker failures also need graph data, not exceptions alone. Hermes CLI, timeout, and parsing failures and exhausted Codex failures are stored as structured worker errors and routed to reason-specific interrupts. Unexpected programming errors still throw and retain the last checkpoint and worktree, but the CLI removes the invocation's repository lease before surfacing the error so the repository is not permanently stranded. Hard crashes remain a manual stale-lease recovery case. This keeps operational recovery explicit without swallowing defects.

Validation output and repository diffs can be much larger than the actionable evidence. The checkpoint retains bounded command results for inspection, but retry and review prompts receive smaller head-and-tail excerpts of validation and diff content. High-confidence local runtime failures, currently shell command absence, Node native-module ABI mismatch, and package-engine mismatch, route to `validation_environment_failed` without incrementing the Codex attempt because another coding pass cannot repair the invoking environment.

The terminal-default TUI remains inside the synchronous process and is skipped automatically when standard input or output is redirected. It consumes the existing structured event stream and can request a pause only after a graph node completes; guidance resumes through the same LangGraph interrupt and checkpoint path. It cannot inject text into a Hermes or Codex one-shot subprocess that is already running.

## Decisions carried into the plan

- Use fixed strict-TypeScript graph definitions, Zod-validated state, and pure routing functions.
- Use direct `codex exec`; Hermes never launches Codex.
- Treat research as optional: `research_mode: "off"` bypasses it after planning and after missing-validation resume.
- Use local sequential execution and `SqliteSaver` until concurrency is a measured requirement.
- Use strict structured output for planner, coder summary, and reviewer decisions.
- Enforce review with small deterministic risk rules in addition to planner and user requests.
- Keep validation deterministic, with CLI and checked-in JSON as overrides and exact matches from tracked `AGENTS.md` validation instructions as the default.
- Represent human acceptance of failed validation as `completed_with_override`, not normal completion.
- Derive execution position from LangGraph checkpoint metadata instead of duplicating it in state.
- Retain Codex `workspace-write` sandboxing and never use the bypass flag.
- Require a clean worktree, immutable HEAD and branch, and derive changed files from porcelain status.
- Reject detached HEAD and report only Git-visible changed files, explicitly excluding ignored files from the guarantee.
- Route expected worker failures explicitly; Codex failures cannot fall through to validation.
- Define every reachable interrupt reason and store override reasons for accepted validation or review failures.
- Detect persistent Git-visible Hermes mutations and fail without resume; ignored-file writes and external effects remain outside the check.
- Hold one atomic filesystem process lock around `run` and `resume` so SQLite and the repository have one writer.
- Store runtime data outside repositories, persist per-repository leases across pauses, and require a matching pause fingerprint on resume.
- Disable Codex shell network access and web search with strict per-invocation overrides.
- Keep prompts beside their nodes until their size justifies separate files.
- Build subprocess wrappers before writing the graph.

## Primary sources

- [LangGraph JavaScript persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph JavaScript interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [LangGraph.js SQLite checkpointer](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite)
- [Bun SQLite](https://bun.com/docs/runtime/sqlite)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex configuration reference](https://learn.chatgpt.com/codex/config-file/config-reference)
- [Hermes CLI command reference](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)
