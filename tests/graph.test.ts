import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { promisify } from "node:util";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { runCodex, runHermes } from "../src/agents.js";
import {
  createLease,
  getLease,
  preflightRepository,
  removeLease,
  updateLease,
  withProcessLock,
  worktreeFingerprint,
} from "../src/checkpoint.js";
import { buildGraph, resumeCommand } from "../src/graph.js";
import type { CommandResult, WorkflowStateValue } from "../src/state.js";
import type { runValidationCommand } from "../src/validation.js";

const exec = promisify(execFile);

const ok = (argv = ["fake"]): CommandResult => ({
  argv,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  durationMs: 1,
});

const failed = (argv = ["fake"]): CommandResult => ({
  ...ok(argv),
  exitCode: 1,
  stderr: "failed",
});

async function repository(): Promise<{
  repo: string;
  head: string;
  branch: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-graph-"));
  const repo = join(root, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "fixture\n");
  await exec("git", ["add", "README.md"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  const baseline = await preflightRepository(repo);
  return { ...baseline, root, repo: await realpath(repo) };
}

function initial(
  fixture: { repo: string; head: string; branch: string },
  update: Record<string, unknown> = {},
) {
  return {
    runId: `run-${Date.now()}-${Math.random()}`,
    task: "Add a sum function",
    repo: fixture.repo,
    baselineHead: fixture.head,
    baselineBranch: fixture.branch,
    validationCommands: ["npm test"],
    validationSource: "cli" as const,
    userRequestedReview: false,
    researchMode: "auto" as const,
    attempt: 1,
    maxAttempts: 3,
    status: "running" as const,
    hermesTimeoutMs: 2_000,
    codexTimeoutMs: 2_000,
    validationTimeoutMs: 2_000,
    ...update,
  };
}

function plannerOutput(reviewRequired = false) {
  return {
    plan: "Add the function and test it.",
    research_required: false,
    research_reason: "",
    review_required: reviewRequired,
    review_reason: reviewRequired ? "Independent review requested" : "",
    validation_coverage_complete: true,
    validation_commands: ["npm test"],
  };
}

test("Codex and validation failures retry Codex without premature validation", async () => {
  const fixture = await repository();
  let coderCalls = 0;
  const coderPrompts: string[] = [];
  let validationCalls = 0;
  let reviewerCalls = 0;
  const hermes = (async (_prompt, _repo, _timeout, kind) => {
    if (kind === "reviewer") reviewerCalls += 1;
    return {
      result: ok(["hermes"]),
      output:
        kind === "planner"
          ? plannerOutput()
          : kind === "research"
            ? { findings: "none" }
            : { decision: "approved" as const, findings: "looks good" },
    };
  }) as typeof runHermes;
  const codex = (async (prompt, repo) => {
    coderPrompts.push(prompt);
    coderCalls += 1;
    await writeFile(join(repo, "sum.ts"), `export const sum = (a: number, b: number) => a + b;\n// attempt ${coderCalls}\n`);
    if (coderCalls === 1) return { result: failed(["codex"]) };
    return { result: ok(["codex"]), summary: `attempt ${coderCalls}` };
  }) as typeof runCodex;
  const validate = (async () => {
    validationCalls += 1;
    return validationCalls === 1
      ? { ...failed(["npm", "test"]), stderr: `failure-start\n${"x".repeat(20_000)}\nfailure-end` }
      : ok(["npm", "test"]);
  }) as typeof runValidationCommand;
  try {
    const graph = buildGraph(new MemorySaver(), {
      hermes,
      codex,
      validate,
      dataRoot: join(fixture.root, "data"),
    });
    const input = initial(fixture);
    const result = (await graph.invoke(input, {
      configurable: { thread_id: input.runId },
    })) as WorkflowStateValue;
    assert.equal(result.status, "completed");
    assert.equal(result.attempt, 3);
    assert.equal(coderCalls, 3);
    assert.equal(validationCalls, 2);
    assert.equal(reviewerCalls, 0);
    assert.deepEqual(result.changedFiles, ["sum.ts"]);
    assert.equal(result.humanReason, undefined);
    assert.equal(result.workerErrorSource, null);
    assert.equal(result.workerError, null);
    assert.match(coderPrompts[2] ?? "", /characters omitted/);
    assert.match(coderPrompts[2] ?? "", /failure-end/);
    assert.ok((coderPrompts[2]?.length ?? Infinity) < 8_000);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("planner selects validation copied from tracked AGENTS.md instructions", async () => {
  const fixture = await repository();
  const calls: string[] = [];
  const hermes = (async (_prompt, _repo, _timeout, kind) => ({
    result: ok(["hermes"]),
    output:
      kind === "planner"
        ? { ...plannerOutput(), validation_commands: ["bun test", "invented"] }
        : { decision: "approved" as const, findings: "fine" },
  })) as typeof runHermes;
  const codex = (async (_prompt, repo) => {
    await writeFile(join(repo, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
    return { result: ok(["codex"]), summary: "implemented" };
  }) as typeof runCodex;
  try {
    const graph = buildGraph(new MemorySaver(), {
      hermes,
      codex,
      trustedValidation: async (_repo, suggestions) =>
        suggestions.filter((command) => command === "bun test"),
      validate: async (command) => {
        calls.push(command);
        return ok(["/bin/sh", "-c", command]);
      },
      dataRoot: join(fixture.root, "data"),
    });
    const input = initial(fixture, {
      validationCommands: [],
      validationSource: undefined,
    });
    await graph.invoke(input, { configurable: { thread_id: input.runId } });
    const state = (
      await graph.getState({ configurable: { thread_id: input.runId } })
    ).values as WorkflowStateValue;
    assert.equal(state.status, "completed");
    assert.equal(state.validationSource, "agents");
    assert.deepEqual(state.validationCommands, ["bun test"]);
    assert.deepEqual(calls, ["bun test"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("environment validation failures pause without spending a Codex attempt", async () => {
  const fixture = await repository();
  let coderCalls = 0;
  let validationCalls = 0;
  const graph = buildGraph(new MemorySaver(), {
    hermes: (async (_prompt, _repo, _timeout, kind) => ({
      result: ok(["hermes"]),
      output:
        kind === "planner"
          ? plannerOutput()
          : kind === "research"
            ? { findings: "none" }
            : { decision: "approved" as const, findings: "" },
    })) as typeof runHermes,
    codex: (async (_prompt, repo) => {
      coderCalls += 1;
      await writeFile(join(repo, "sum.ts"), "export const sum = () => 1;\n");
      return { result: ok(["codex"]), summary: "changed" };
    }) as typeof runCodex,
    validate: (async () => {
      validationCalls += 1;
      return validationCalls === 1
        ? {
            ...failed(["npm", "test"]),
            stderr: "better_sqlite3.node was compiled against a different Node.js version; NODE_MODULE_VERSION 137",
          }
        : ok(["npm", "test"]);
    }) as typeof runValidationCommand,
    dataRoot: join(fixture.root, "data"),
  });
  const input = initial(fixture);
  try {
    await graph.invoke(input, { configurable: { thread_id: input.runId } });
    let state = (await graph.getState({ configurable: { thread_id: input.runId } })).values as WorkflowStateValue;
    assert.equal(state.status, "waiting_for_human");
    assert.equal(state.humanReason, "validation_environment_failed");
    assert.equal(state.attempt, 1);
    assert.equal(coderCalls, 1);

    await graph.invoke(resumeCommand({ response: "retry" }), {
      configurable: { thread_id: input.runId },
    });
    state = (await graph.getState({ configurable: { thread_id: input.runId } })).values as WorkflowStateValue;
    assert.equal(state.status, "completed");
    assert.equal(coderCalls, 1);
    assert.equal(validationCalls, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("operator pause accepts guidance before the next safe graph node", async () => {
  const fixture = await repository();
  let pause = true;
  let coderPrompt = "";
  const graph = buildGraph(new MemorySaver(), {
    hermes: (async (_prompt, _repo, _timeout, kind) => ({
      result: ok(["hermes"]),
      output:
        kind === "planner"
          ? plannerOutput()
          : kind === "research"
            ? { findings: "none" }
            : { decision: "approved" as const, findings: "" },
    })) as typeof runHermes,
    codex: (async (prompt, repo) => {
      coderPrompt = prompt;
      await writeFile(join(repo, "sum.ts"), "export const sum = () => 1;\n");
      return { result: ok(["codex"]), summary: "changed" };
    }) as typeof runCodex,
    validate: (async () => ok(["npm", "test"])) as typeof runValidationCommand,
    pauseRequested: () => {
      const requested = pause;
      pause = false;
      return requested;
    },
    dataRoot: join(fixture.root, "data"),
  });
  const input = initial(fixture);
  try {
    await graph.invoke(input, { configurable: { thread_id: input.runId } });
    let state = (await graph.getState({ configurable: { thread_id: input.runId } })).values as WorkflowStateValue;
    assert.equal(state.status, "waiting_for_human");
    assert.equal(state.humanReason, "operator_pause");
    assert.equal(state.resumeTarget, "coder");

    await graph.invoke(
      resumeCommand({ response: "revise", message: "Keep GUIDE.md unchanged." }),
      { configurable: { thread_id: input.runId } },
    );
    state = (await graph.getState({ configurable: { thread_id: input.runId } })).values as WorkflowStateValue;
    assert.equal(state.status, "completed");
    assert.equal(state.attempt, 1);
    assert.match(coderPrompt, /Keep GUIDE\.md unchanged/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed planner interrupts, retries the same worker, then routes required research", async () => {
  const fixture = await repository();
  const calls: string[] = [];
  let plannerCalls = 0;
  const hermes = (async (_prompt, _repo, _timeout, kind) => {
    calls.push(kind);
    if (kind === "planner") {
      plannerCalls += 1;
      if (plannerCalls === 1) return { result: failed(["hermes"]) };
      return {
        result: ok(["hermes"]),
        output: {
          ...plannerOutput(),
          research_required: true,
          research_reason: "Confirm an implementation detail",
        },
      };
    }
    if (kind === "research") {
      return { result: ok(["hermes"]), output: { findings: "Use ordinary addition." } };
    }
    return {
      result: ok(["hermes"]),
      output: { decision: "approved" as const, findings: "fine" },
    };
  }) as typeof runHermes;
  const codex = (async (_prompt, repo) => {
    await writeFile(join(repo, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
    return { result: ok(["codex"]), summary: "implemented" };
  }) as typeof runCodex;
  try {
    const graph = buildGraph(new MemorySaver(), {
      hermes,
      codex,
      validate: (async () => ok(["npm", "test"])) as typeof runValidationCommand,
      dataRoot: join(fixture.root, "data"),
    });
    const input = initial(fixture);
    await graph.invoke(input, { configurable: { thread_id: input.runId } });
    let state = (
      await graph.getState({ configurable: { thread_id: input.runId } })
    ).values as WorkflowStateValue;
    assert.equal(state.status, "waiting_for_human");
    assert.equal(state.humanReason, "agent_execution_failed");
    await graph.invoke(resumeCommand({ response: "retry" }), {
      configurable: { thread_id: input.runId },
    });
    state = (
      await graph.getState({ configurable: { thread_id: input.runId } })
    ).values as WorkflowStateValue;
    assert.equal(state.status, "completed");
    assert.equal(state.researchFindings, "Use ordinary addition.");
    assert.deepEqual(calls, ["planner", "planner", "research"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("SQLite persists a missing-validation interrupt and resumes the same thread", async () => {
  const fixture = await repository();
  const database = join(fixture.root, "checkpoints.sqlite3");
  let plannerCalls = 0;
  const hermes = (async (_prompt, _repo, _timeout, kind) => {
    if (kind === "planner") plannerCalls += 1;
    return {
      result: ok(["hermes"]),
      output:
        kind === "planner"
          ? plannerOutput()
          : kind === "research"
            ? { findings: "none" }
            : { decision: "approved" as const, findings: "fine" },
    };
  }) as typeof runHermes;
  const codex = (async (_prompt, repo) => {
    await writeFile(join(repo, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
    return { result: ok(["codex"]), summary: "implemented" };
  }) as typeof runCodex;
  const validate = (async () => ok(["npm", "test"])) as typeof runValidationCommand;
  const runId = `sqlite-${Date.now()}`;
  let saver = SqliteSaver.fromConnString(database);
  try {
    let graph = buildGraph(saver, {
      hermes,
      codex,
      validate,
      dataRoot: join(fixture.root, "data"),
    });
    await graph.invoke(
      initial(fixture, { runId, validationCommands: [], validationSource: undefined }),
      { configurable: { thread_id: runId } },
    );
    let snapshot = await graph.getState({ configurable: { thread_id: runId } });
    let state = snapshot.values as WorkflowStateValue;
    assert.equal(state.status, "waiting_for_human");
    assert.equal(state.humanReason, "validation_commands_missing");
    assert.deepEqual(snapshot.next, ["human_checkpoint"]);
    assert.ok(state.pausedWorktreeFingerprint);
    assert.equal(plannerCalls, 1);

    saver.db.close();
    saver = SqliteSaver.fromConnString(database);
    graph = buildGraph(saver, {
      hermes,
      codex,
      validate,
      dataRoot: join(fixture.root, "data"),
    });
    snapshot = await graph.getState({ configurable: { thread_id: runId } });
    assert.equal((snapshot.values as WorkflowStateValue).status, "waiting_for_human");

    await graph.invoke(
      resumeCommand({ response: "provide_validation", validationCommands: ["npm test"] }),
      { configurable: { thread_id: runId } },
    );
    state = (await graph.getState({ configurable: { thread_id: runId } }))
      .values as WorkflowStateValue;
    assert.equal(state.status, "completed");
    assert.equal(state.validationPassed, true);
    assert.equal(plannerCalls, 1);
  } finally {
    saver.db.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("research mode off skips research after validation is provided", async () => {
  const fixture = await repository();
  const calls: string[] = [];
  const hermes = (async (_prompt, _repo, _timeout, kind) => {
    calls.push(kind);
    return {
      result: ok(["hermes"]),
      output:
        kind === "planner"
          ? {
              ...plannerOutput(),
              research_required: true,
              research_reason: "Confirm an implementation detail",
            }
          : kind === "research"
            ? { findings: "should not run" }
            : { decision: "approved" as const, findings: "fine" },
    };
  }) as typeof runHermes;
  const codex = (async (_prompt, repo) => {
    calls.push("coder");
    await writeFile(join(repo, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
    return { result: ok(["codex"]), summary: "implemented" };
  }) as typeof runCodex;
  const validate = (async () => {
    calls.push("validation");
    return ok(["npm", "test"]);
  }) as typeof runValidationCommand;
  try {
    const graph = buildGraph(new MemorySaver(), {
      hermes,
      codex,
      validate,
      dataRoot: join(fixture.root, "data"),
    });
    const input = initial(fixture, {
      validationCommands: [],
      validationSource: undefined,
      researchMode: "off",
    });
    await graph.invoke(input, { configurable: { thread_id: input.runId } });
    let state = (
      await graph.getState({ configurable: { thread_id: input.runId } })
    ).values as WorkflowStateValue;
    assert.equal(state.status, "waiting_for_human");
    assert.equal(state.humanReason, "validation_commands_missing");
    assert.deepEqual(calls, ["planner"]);

    await graph.invoke(
      resumeCommand({ response: "provide_validation", validationCommands: ["npm test"] }),
      { configurable: { thread_id: input.runId } },
    );
    state = (
      await graph.getState({ configurable: { thread_id: input.runId } })
    ).values as WorkflowStateValue;
    assert.equal(state.status, "completed");
    assert.equal(state.validationPassed, true);
    assert.equal(state.researchFindings, "");
    assert.deepEqual(calls, ["planner", "coder", "validation"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("review changes loop to Codex and exhausted failures require explicit override", async () => {
  const fixture = await repository();
  let coderCalls = 0;
  let reviewerCalls = 0;
  const hermes = (async (_prompt, _repo, _timeout, kind) => {
    if (kind === "reviewer") reviewerCalls += 1;
    return {
      result: ok(["hermes"]),
      output:
        kind === "planner"
          ? plannerOutput(true)
          : kind === "research"
            ? { findings: "none" }
            : {
                decision: reviewerCalls === 1 ? ("changes_requested" as const) : ("approved" as const),
                findings: reviewerCalls === 1 ? "add an edge case" : "approved",
              },
    };
  }) as typeof runHermes;
  const codex = (async (_prompt, repo) => {
    coderCalls += 1;
    await writeFile(join(repo, "sum.ts"), `export const sum = (a: number, b: number) => a + b; // ${coderCalls}\n`);
    return { result: ok(["codex"]), summary: `attempt ${coderCalls}` };
  }) as typeof runCodex;
  const validate = (async () => ok(["npm", "test"])) as typeof runValidationCommand;
  try {
    const graph = buildGraph(new MemorySaver(), {
      hermes,
      codex,
      validate,
      dataRoot: join(fixture.root, "data"),
    });
    const input = initial(fixture);
    const result = (await graph.invoke(input, {
      configurable: { thread_id: input.runId },
    })) as WorkflowStateValue;
    assert.equal(result.status, "completed");
    assert.equal(coderCalls, 2);
    assert.equal(reviewerCalls, 2);

    const overrideRun = initial(fixture, {
      runId: `override-${Date.now()}`,
      task: "Change another file",
      maxAttempts: 1,
    });
    const failingGraph = buildGraph(new MemorySaver(), {
      hermes: (async (_prompt, _repo, _timeout, kind) => ({
        result: ok(["hermes"]),
        output:
          kind === "planner"
            ? plannerOutput(false)
            : kind === "research"
              ? { findings: "none" }
              : { decision: "approved" as const, findings: "" },
      })) as typeof runHermes,
      codex: (async (_prompt, repo) => {
        await writeFile(join(repo, "other.ts"), "export const value = 1;\n");
        return { result: ok(["codex"]), summary: "changed" };
      }) as typeof runCodex,
      validate: (async () => failed(["npm", "test"])) as typeof runValidationCommand,
      dataRoot: join(fixture.root, "data"),
    });
    await failingGraph.invoke(overrideRun, {
      configurable: { thread_id: overrideRun.runId },
    });
    let overrideState = (
      await failingGraph.getState({ configurable: { thread_id: overrideRun.runId } })
    ).values as WorkflowStateValue;
    assert.equal(overrideState.humanReason, "validation_failed_exhausted");
    await failingGraph.invoke(
      resumeCommand({
        response: "accept_with_failed_validation",
        message: "Known failure accepted for this local experiment.",
      }),
      { configurable: { thread_id: overrideRun.runId } },
    );
    overrideState = (
      await failingGraph.getState({ configurable: { thread_id: overrideRun.runId } })
    ).values as WorkflowStateValue;
    assert.equal(overrideState.status, "completed_with_override");
    assert.equal(overrideState.humanReason, undefined);
    assert.match(overrideState.overrideReasons[0] ?? "", /Known failure accepted/);

    const emptyRevisionRun = initial(fixture, {
      runId: `empty-revision-${Date.now()}`,
      task: "Reject an empty revision",
      maxAttempts: 1,
    });
    await failingGraph.invoke(emptyRevisionRun, {
      configurable: { thread_id: emptyRevisionRun.runId },
    });
    await assert.rejects(
      failingGraph.invoke(
        resumeCommand({ response: "revise" }),
        { configurable: { thread_id: emptyRevisionRun.runId } },
      ),
      /revise requires corrective guidance/,
    );

    const abortRun = initial(fixture, {
      runId: `abort-${Date.now()}`,
      task: "Abort another failed change",
      maxAttempts: 1,
    });
    await failingGraph.invoke(abortRun, {
      configurable: { thread_id: abortRun.runId },
    });
    await failingGraph.invoke(
      resumeCommand({ response: "abort", message: "Stop this run." }),
      { configurable: { thread_id: abortRun.runId } },
    );
    const abortedState = (
      await failingGraph.getState({ configurable: { thread_id: abortRun.runId } })
    ).values as WorkflowStateValue;
    assert.equal(abortedState.status, "failed");
    assert.equal(abortedState.humanReason, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Hermes mutation fails immediately and lock, lease, and fingerprint guards hold", async () => {
  const fixture = await repository();
  const dataRoot = join(fixture.root, "data");
  const input = initial(fixture);
  try {
    const graph = buildGraph(new MemorySaver(), {
      hermes: (async (_prompt, repo) => {
        await writeFile(join(repo, "illegal.txt"), "Hermes wrote this\n");
        return { result: ok(["hermes"]), output: plannerOutput() };
      }) as typeof runHermes,
      dataRoot,
    });
    const result = (await graph.invoke(input, {
      configurable: { thread_id: input.runId },
    })) as WorkflowStateValue;
    assert.equal(result.status, "failed");
    assert.equal(result.boundaryViolation, true);
    assert.match(result.boundaryEvidence, /Hermes changed/);

    await rm(join(fixture.repo, "illegal.txt"));
    const before = await worktreeFingerprint(fixture);
    await writeFile(join(fixture.repo, "outside-change.txt"), "changed\n");
    const after = await worktreeFingerprint(fixture);
    assert.notEqual(before, after);

    await withProcessLock(async () => {
      await assert.rejects(withProcessLock(async () => undefined, dataRoot), /writer is active/);
    }, dataRoot);

    await createLease(fixture.repo, input.runId, dataRoot);
    assert.equal((await getLease(fixture.repo, dataRoot))?.status, "running");
    await updateLease(fixture.repo, input.runId, "waiting_for_human", dataRoot);
    assert.equal((await getLease(fixture.repo, dataRoot))?.status, "waiting_for_human");
    await assert.rejects(createLease(fixture.repo, "other", dataRoot), /already leased/);
    await removeLease(fixture.repo, input.runId, dataRoot);
    assert.equal(await getLease(fixture.repo, dataRoot), undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the compiled CLI runs, reports status, and resumes a persisted interrupt", async () => {
  const fixture = await repository();
  const bin = join(fixture.root, "bin");
  const dataHome = join(fixture.root, "xdg");
  await mkdir(bin);
  const hermes = join(bin, "hermes");
  const codex = join(bin, "codex");
  await writeFile(
    hermes,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: hermes -z PROMPT");
} else {
  process.stdout.write(JSON.stringify({plan:"Add sum.ts",research_required:false,research_reason:"",review_required:false,review_reason:"",validation_coverage_complete:true,validation_commands:["test -f sum.ts"]}));
}
`,
  );
  await writeFile(
    codex,
    `#!/usr/bin/env node
const fs = await import("node:fs/promises");
const path = await import("node:path");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write("--ask-for-approval");
} else if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write("--cd --sandbox --ask-for-approval --strict-config --output-schema --output-last-message");
} else {
  const repo = args[args.indexOf("--cd") + 1];
  const output = args[args.indexOf("--output-last-message") + 1];
  await fs.writeFile(path.join(repo, "sum.ts"), "export const sum = (a, b) => a + b;\\n");
  await fs.writeFile(output, JSON.stringify({summary:"Added sum.ts"}));
}
`,
  );
  await chmod(hermes, 0o755);
  await chmod(codex, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_DATA_HOME: dataHome,
    HERMES_PATH: hermes,
    CODEX_PATH: codex,
  };
  const cli = join(process.cwd(), "dist", "src", "cli.js");
  try {
    const started = await exec(
      process.execPath,
      [cli, "run", "--task", "Add a sum function"],
      { cwd: fixture.repo, env, maxBuffer: 2 * 1024 * 1024 },
    );
    const runId = /Run ID: ([^\s]+)/.exec(started.stdout)?.[1];
    assert.ok(runId);
    assert.match(started.stdout, /"status": "waiting_for_human"/);

    const paused = await exec(process.execPath, [cli, "status", runId], {
      cwd: process.cwd(),
      env,
    });
    const pausedStatus = JSON.parse(paused.stdout) as {
      status: string;
      pendingNodes: string[];
      humanReason: string;
      checkpointCount: number;
      latestCheckpointId: string;
      completedNodes?: string[];
    };
    assert.equal(pausedStatus.status, "waiting_for_human");
    assert.deepEqual(pausedStatus.pendingNodes, ["human_checkpoint"]);
    assert.equal(pausedStatus.humanReason, "validation_commands_missing");
    assert.ok(pausedStatus.checkpointCount > 0);
    assert.ok(pausedStatus.latestCheckpointId);
    assert.equal(pausedStatus.completedNodes, undefined);

    await writeFile(join(fixture.repo, "external.txt"), "external change\n");
    await assert.rejects(
      exec(
        process.execPath,
        [
          cli,
          "resume",
          runId,
          "--response",
          "provide_validation",
          "--validate",
          "test -f sum.ts",
        ],
        { cwd: process.cwd(), env },
      ),
      /Repository changed after the interrupt/,
    );
    const leasesAfterRefusal = JSON.parse(
      await readFile(join(dataHome, "agent-workflow", "active-runs.json"), "utf8"),
    ) as Record<string, { run_id: string }>;
    assert.equal(leasesAfterRefusal[fixture.repo]?.run_id, runId);
    await rm(join(fixture.repo, "external.txt"));

    const resumed = await exec(
      process.execPath,
      [
        cli,
        "resume",
        runId,
        "--response",
        "provide_validation",
        "--validate",
        "test -f sum.ts",
      ],
      { cwd: process.cwd(), env, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.match(resumed.stdout, /"status": "completed"/);

    const completed = await exec(process.execPath, [cli, "status", runId], {
      cwd: process.cwd(),
      env,
    });
    const completedStatus = JSON.parse(completed.stdout) as {
      status: string;
      pendingNodes: string[];
      repositoryChangedFiles: string[];
    };
    assert.equal(completedStatus.status, "completed");
    assert.deepEqual(completedStatus.pendingNodes, []);
    assert.deepEqual(completedStatus.repositoryChangedFiles, ["sum.ts"]);
    assert.deepEqual(
      JSON.parse(await readFile(join(dataHome, "agent-workflow", "active-runs.json"), "utf8")),
      {},
    );

    await exec("git", ["add", "sum.ts"], { cwd: fixture.repo });
    await exec("git", ["commit", "-m", "prepare revise validation"], { cwd: fixture.repo });
    const failedValidation = await exec(
      process.execPath,
      [
        cli,
        "run",
        "--repo",
        fixture.repo,
        "--task",
        "Exercise revision validation",
        "--validate",
        "false",
        "--max-attempts",
        "1",
      ],
      { cwd: process.cwd(), env, maxBuffer: 2 * 1024 * 1024 },
    );
    const failedRunId = /Run ID: ([^\s]+)/.exec(failedValidation.stdout)?.[1];
    assert.ok(failedRunId);
    await assert.rejects(
      exec(
        process.execPath,
        [cli, "resume", failedRunId, "--response", "revise"],
        { cwd: process.cwd(), env },
      ),
      /revise requires --message with corrective guidance/,
    );
    await assert.rejects(readFile(join(fixture.repo, "checkpoints.sqlite3")), /ENOENT/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the CLI releases a repository lease after an unexpected graph exception", async () => {
  const fixture = await repository();
  const bin = join(fixture.root, "crash-bin");
  const dataHome = join(fixture.root, "crash-xdg");
  await mkdir(bin);
  const hermes = join(bin, "hermes");
  const codex = join(bin, "codex");
  await writeFile(
    hermes,
    `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  process.stdout.write("Usage: hermes -z PROMPT");
} else {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.rm(path.join(process.cwd(), ".git", "HEAD"));
  process.stdout.write(JSON.stringify({plan:"trigger failure",research_required:false,research_reason:"",review_required:false,review_reason:"",validation_coverage_complete:true,validation_commands:["true"]}));
}
`,
  );
  await writeFile(
    codex,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--help") process.stdout.write("--ask-for-approval");
else if (args[0] === "exec" && args[1] === "--help") process.stdout.write("--cd --sandbox --strict-config --output-schema --output-last-message");
`,
  );
  await chmod(hermes, 0o755);
  await chmod(codex, 0o755);
  const env = {
    ...process.env,
    XDG_DATA_HOME: dataHome,
    HERMES_PATH: hermes,
    CODEX_PATH: codex,
  };
  const cli = join(process.cwd(), "dist", "src", "cli.js");
  try {
    await assert.rejects(
      exec(
        process.execPath,
        [
          cli,
          "run",
          "--repo",
          fixture.repo,
          "--task",
          "Trigger an unexpected graph failure",
          "--validate",
          "true",
        ],
        { cwd: process.cwd(), env },
      ),
      /git rev-parse HEAD failed/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(dataHome, "agent-workflow", "active-runs.json"), "utf8")),
      {},
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
