---
name: agent-workflow
description: Run the local LangGraph workflow for repository changes that need deterministic validation, bounded retries, resumability, or independent review.
---

# Agent Workflow

Use `agent-workflow` for scoped multi-file repository changes with meaningful validation, retries, review, or interruption recovery. Handle questions, research-only work, one-line edits, repositories without trusted validation, and small deterministic changes directly.

Before starting, confirm the exact repository root is clean and on a named branch. Run the workflow once, report its printed run ID, and use `agent-workflow status RUN_ID` before considering a restart. Resume a paused run with the response allowed by its interrupt payload; do not recreate graph state, increase retries, or imitate transitions yourself.

```bash
agent-workflow run --repo "/absolute/repository/root" --task "Exact task" --validate "trusted command"
```

LangGraph owns the run after startup. Do not generate graphs, call Codex outside the workflow for the same run, or treat Hermes memory as current execution state.
