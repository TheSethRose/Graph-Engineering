#!/usr/bin/env -S bun --no-env-file
import { randomUUID } from "node:crypto";
import {
  assertGitInvariants,
  changedFiles,
  createCheckpointer,
  createLease,
  getDataRoot,
  getLease,
  preflightRepository,
  removeLease,
  updateLease,
  withProcessLock,
  worktreeFingerprint,
} from "./checkpoint.js";
import { logEvent, setEventSink } from "./events.js";
import {
  checkCliCompatibility,
  loadAgentEnvironment,
  setCommandTracing,
} from "./agents.js";
import { buildGraph, resumeCommand } from "./graph.js";
import { allowedResponses, type WorkflowStateValue } from "./state.js";
import { WorkflowTui } from "./tui.js";
import { loadWorkflowConfig, type ConfigOverrides } from "./validation.js";

type Parsed = { positionals: string[]; options: Map<string, string[]> };

const HELP = `Agent Workflow runs a local Hermes, Codex, validation, and review workflow.

Usage:
  agent-workflow --help
  agent-workflow [--task TASK] [OPTIONS]
  agent-workflow run [--task TASK] [OPTIONS]
  agent-workflow status RUN_ID
  agent-workflow resume RUN_ID --response RESPONSE [OPTIONS]

Commands:
  run       Explicit alias for starting a new workflow.
  status    Inspect a saved run without executing it.
  resume    Continue a run that is waiting for human input.

Run options:
  --repo PATH                       Target Git repository. Defaults to the current directory.
  --task TASK                       Exact change to make. Prompted for in the TUI when omitted.
  --validate COMMAND                Override validation from AGENTS.md. Repeatable.
  --max-attempts N                  Positive limit for implementation attempts.
  --review-required                 Require Hermes review after implementation and validation.
  --research-mode auto|off          Allow or disable optional Hermes research.
  --hermes-timeout-seconds N        Positive Hermes timeout in seconds.
  --codex-timeout-seconds N         Positive Codex timeout in seconds.
  --validation-timeout-seconds N    Positive timeout for each validation command.
  --verbose                         Show redacted commands, heartbeats, and exit details.
  --trace                           Include redacted worker stdout and stderr.
  --interactive                     Require the TUI even when terminal detection is unavailable.
  --no-interactive                  Disable the default TUI and print structured output.

Resume options:
  --response RESPONSE               A response listed by status. Required.
  --message MESSAGE                 Required for revise and override responses.
  --validate COMMAND                Repeatable; allowed only with provide_validation.
  --verbose                         Show redacted commands, heartbeats, and exit details.
  --trace                           Include redacted worker stdout and stderr.
  --interactive                     Require the TUI even when terminal detection is unavailable.
  --no-interactive                  Disable the default TUI and print structured output.

Responses:
  approve | continue | revise | abort | retry | provide_validation
  accept_with_failed_validation | accept_with_review_findings

Notes:
  Run uses the current directory unless --repo is supplied.
  A terminal opens the TUI by default; redirected output stays structured.
  Interactive runs prompt for the task when --task is omitted.
  Validation defaults to exact commands selected from tracked AGENTS.md instructions.
  Run settings other than --repo and --task may come from a tracked .agent-workflow.json.
  Repeated --validate flags replace validation commands from that file.
  --review-required is a post-implementation Hermes review, not human approval before editing.
  Run "agent-workflow status RUN_ID" before resuming or restarting a saved run.
`;

function usage(): never {
  throw new Error(`${HELP}\nRun "agent-workflow --help" for command details.`);
}

function parseArgs(args: string[]): Parsed {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const booleanFlags = new Set([
    "--review-required",
    "--verbose",
    "--trace",
    "--interactive",
    "--no-interactive",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (booleanFlags.has(value)) {
      options.set(value, ["true"]);
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value.`);
    options.set(value, [...(options.get(value) ?? []), next]);
    index += 1;
  }
  return { positionals, options };
}

function one(parsed: Parsed, name: string, required = false): string | undefined {
  const values = parsed.options.get(name) ?? [];
  if (values.length > 1) throw new Error(`${name} may be supplied only once.`);
  if (required && !values[0]) throw new Error(`${name} is required.`);
  return values[0];
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function rejectUnknown(parsed: Parsed, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of parsed.options.keys()) {
    if (!allowedSet.has(key)) throw new Error(`Unknown option ${key}.`);
  }
}

function configOverrides(parsed: Parsed): ConfigOverrides {
  const seconds = (name: string) => {
    const value = positiveInteger(one(parsed, name), name);
    return value === undefined ? undefined : value * 1_000;
  };
  const researchMode = one(parsed, "--research-mode");
  if (researchMode !== undefined && researchMode !== "auto" && researchMode !== "off") {
    throw new Error("--research-mode must be auto or off.");
  }
  return {
    ...(parsed.options.has("--validate")
      ? { validationCommands: parsed.options.get("--validate")! }
      : {}),
    ...(one(parsed, "--max-attempts")
      ? { maxAttempts: positiveInteger(one(parsed, "--max-attempts"), "--max-attempts")! }
      : {}),
    ...(parsed.options.has("--review-required") ? { reviewRequired: true } : {}),
    ...(researchMode ? { researchMode } : {}),
    ...(seconds("--hermes-timeout-seconds")
      ? { hermesTimeoutMs: seconds("--hermes-timeout-seconds")! }
      : {}),
    ...(seconds("--codex-timeout-seconds")
      ? { codexTimeoutMs: seconds("--codex-timeout-seconds")! }
      : {}),
    ...(seconds("--validation-timeout-seconds")
      ? { validationTimeoutMs: seconds("--validation-timeout-seconds")! }
      : {}),
  };
}

const configFor = (runId: string) => ({ configurable: { thread_id: runId } });

async function finishInvocation(
  state: WorkflowStateValue,
  dataRoot: string,
  checkpointId?: string,
  printResult = true,
): Promise<void> {
  if (state.status === "waiting_for_human") {
    await updateLease(state.repo, state.runId, "waiting_for_human", dataRoot);
  } else if (["completed", "completed_with_override", "failed", "cancelled"].includes(state.status)) {
    await removeLease(state.repo, state.runId, dataRoot);
  }
  if (!printResult) return;
  process.stdout.write(`${JSON.stringify({
    runId: state.runId,
    checkpointId,
    status: state.status,
    attempt: state.attempt,
    changedFiles: state.changedFiles,
    validationPassed: state.validationPassed,
    validationResults: state.validationResults,
    reviewDecision: state.reviewDecision,
    reviewResult: state.reviewResult,
    humanReason: state.humanReason,
    overrideReasons: state.overrideReasons,
    workerError: state.workerError,
    remainingConcerns: state.errors,
    stopReason: state.stopReason,
  }, null, 2)}\n`);
}

function startInterface(parsed: Parsed): WorkflowTui | undefined {
  if (parsed.options.has("--interactive") && parsed.options.has("--no-interactive")) {
    throw new Error("--interactive and --no-interactive cannot be used together.");
  }
  const interactive =
    !parsed.options.has("--no-interactive") &&
    (parsed.options.has("--interactive") || (process.stdin.isTTY && process.stdout.isTTY));
  const trace = parsed.options.has("--trace");
  setCommandTracing(trace ? "full" : parsed.options.has("--verbose") || interactive ? "summary" : false);
  if (!interactive) return undefined;
  const tui = new WorkflowTui(
    (full) => setCommandTracing(full ? "full" : "summary"),
    trace,
  );
  setEventSink(tui.handleEvent);
  tui.start();
  return tui;
}

function stopInterface(tui?: WorkflowTui): void {
  setEventSink();
  tui?.stop();
  setCommandTracing(false);
}

async function settleInvocation(
  graph: ReturnType<typeof buildGraph>,
  runId: string,
  dataRoot: string,
  tui?: WorkflowTui,
): Promise<void> {
  while (true) {
    const snapshot = await graph.getState(configFor(runId));
    const state = snapshot.values as WorkflowStateValue;
    const checkpointId = snapshot.config.configurable?.checkpoint_id;
    if (tui && state.status === "waiting_for_human" && state.humanReason === "operator_pause") {
      await finishInvocation(state, dataRoot, checkpointId, false);
      const response = await tui.waitForOperatorResponse();
      await updateLease(state.repo, runId, "running", dataRoot);
      logEvent("run_resumed", { runId, response: response.response });
      await graph.invoke(resumeCommand(response), configFor(runId));
      continue;
    }
    await finishInvocation(state, dataRoot, checkpointId, tui === undefined);
    tui?.showFinal(state);
    return;
  }
}

async function run(parsed: Parsed): Promise<void> {
  rejectUnknown(parsed, [
    "--repo",
    "--task",
    "--validate",
    "--max-attempts",
    "--review-required",
    "--research-mode",
    "--hermes-timeout-seconds",
    "--codex-timeout-seconds",
    "--validation-timeout-seconds",
    "--verbose",
    "--trace",
    "--interactive",
    "--no-interactive",
  ]);
  if (parsed.positionals.length > 0) usage();
  const repoInput = one(parsed, "--repo") ?? process.cwd();
  const dataRoot = getDataRoot();
  const tui = startInterface(parsed);
  try {
    const taskOption = one(parsed, "--task");
    const task = taskOption === undefined ? await tui?.promptTask() : taskOption.trim();
    if (taskOption !== undefined && !task) throw new Error("--task must not be empty.");
    if (task === undefined) {
      throw new Error("--task is required when interactive task entry is unavailable.");
    }
    await withProcessLock(async () => {
    const baseline = await preflightRepository(repoInput);
    const workflowConfig = await loadWorkflowConfig(baseline.repo, configOverrides(parsed));
    await checkCliCompatibility(baseline.repo);
    const runId = randomUUID();
    const checkpointer = await createCheckpointer(dataRoot);
    const graph = buildGraph(checkpointer, {
      dataRoot,
      ...(tui ? { pauseRequested: tui.consumePauseRequest } : {}),
    });
    let leaseCreated = false;
    try {
      await createLease(baseline.repo, runId, dataRoot);
      leaseCreated = true;
      if (!tui) process.stdout.write(`Run ID: ${runId}\n`);
      logEvent("run_started", { runId, repo: baseline.repo });
      await graph.invoke(
        {
          runId,
          task,
          repo: baseline.repo,
          baselineHead: baseline.head,
          baselineBranch: baseline.branch,
          validationCommands: workflowConfig.validationCommands,
          ...(workflowConfig.validationSource
            ? { validationSource: workflowConfig.validationSource }
            : {}),
          userRequestedReview: workflowConfig.reviewRequired,
          researchMode: workflowConfig.researchMode,
          attempt: 1,
          maxAttempts: workflowConfig.maxAttempts,
          status: "running",
          hermesTimeoutMs: workflowConfig.hermesTimeoutMs,
          codexTimeoutMs: workflowConfig.codexTimeoutMs,
          validationTimeoutMs: workflowConfig.validationTimeoutMs,
        },
        configFor(runId),
      );
      await settleInvocation(graph, runId, dataRoot, tui);
    } catch (error) {
      if (leaseCreated) {
        await removeLease(baseline.repo, runId, dataRoot).catch(() => undefined);
      }
      throw error;
    } finally {
      checkpointer.db.close();
    }
    }, dataRoot);
  } finally {
    stopInterface(tui);
  }
}

async function status(parsed: Parsed): Promise<void> {
  rejectUnknown(parsed, []);
  if (parsed.positionals.length !== 1) usage();
  const runId = parsed.positionals[0]!;
  const checkpointer = await createCheckpointer();
  const graph = buildGraph(checkpointer);
  try {
    const snapshot = await graph.getState(configFor(runId));
    const state = snapshot.values as Partial<WorkflowStateValue>;
    if (state.runId !== runId) throw new Error(`Run not found: ${runId}`);
    let checkpointCount = 0;
    for await (const item of graph.getStateHistory(configFor(runId))) {
      void item;
      checkpointCount += 1;
    }
    const interrupts = snapshot.tasks.flatMap((task) => task.interrupts.map((item) => item.value));
    const checkpointFiles = state.changedFiles ?? [];
    const repositoryFiles = state.repo ? await changedFiles(state.repo).catch(() => []) : [];
    const gitInvariantViolation =
      state.repo && state.baselineHead && state.baselineBranch
        ? await assertGitInvariants({
            repo: state.repo,
            head: state.baselineHead,
            branch: state.baselineBranch,
          }).catch((error) => (error instanceof Error ? error.message : String(error)))
        : undefined;
    process.stdout.write(`${JSON.stringify({
      runId,
      status: state.status,
      pendingNodes: snapshot.next,
      checkpointCount,
      latestCheckpointId: snapshot.config.configurable?.checkpoint_id,
      attempt: state.attempt,
      validationPassed: state.validationPassed,
      reviewDecision: state.reviewDecision,
      humanReason: state.humanReason,
      interrupts,
      checkpointChangedFiles: checkpointFiles,
      repositoryChangedFiles: repositoryFiles,
      gitInvariantViolation,
      stopReason: state.stopReason,
    }, null, 2)}\n`);
  } finally {
    checkpointer.db.close();
  }
}

async function resume(parsed: Parsed): Promise<void> {
  rejectUnknown(parsed, [
    "--response",
    "--message",
    "--validate",
    "--verbose",
    "--trace",
    "--interactive",
    "--no-interactive",
  ]);
  if (parsed.positionals.length !== 1) usage();
  const runId = parsed.positionals[0]!;
  const response = one(parsed, "--response", true)!;
  const message = one(parsed, "--message") ?? "";
  const validationCommands = parsed.options.get("--validate") ?? [];
  const dataRoot = getDataRoot();
  const tui = startInterface(parsed);
  try {
    await withProcessLock(async () => {
    const checkpointer = await createCheckpointer(dataRoot);
    const graph = buildGraph(checkpointer, {
      dataRoot,
      ...(tui ? { pauseRequested: tui.consumePauseRequest } : {}),
    });
    try {
      const snapshot = await graph.getState(configFor(runId));
      const state = snapshot.values as WorkflowStateValue;
      if (state.runId !== runId) throw new Error(`Run not found: ${runId}`);
      if (state.status !== "waiting_for_human" || !state.humanReason) {
        throw new Error(`Run ${runId} is not waiting for a human response.`);
      }
      if (!allowedResponses[state.humanReason].includes(response)) {
        throw new Error(`Response ${response} is not allowed for ${state.humanReason}.`);
      }
      if (response === "provide_validation" && validationCommands.length === 0) {
        throw new Error("provide_validation requires at least one --validate command.");
      }
      if (
        ["accept_with_failed_validation", "accept_with_review_findings"].includes(response) &&
        message.trim().length === 0
      ) {
        throw new Error(`${response} requires --message acknowledging the known failure.`);
      }
      if (response === "revise" && message.trim().length === 0) {
        throw new Error("revise requires --message with corrective guidance.");
      }
      if (response !== "provide_validation" && validationCommands.length > 0) {
        throw new Error("--validate is allowed only with provide_validation.");
      }
      const lease = await getLease(state.repo, dataRoot);
      if (lease?.run_id !== runId) throw new Error("Repository lease does not belong to this run.");
      const invariant = await assertGitInvariants({
        repo: state.repo,
        head: state.baselineHead,
        branch: state.baselineBranch,
      });
      if (invariant) throw new Error(invariant);
      const fingerprint = await worktreeFingerprint({
        repo: state.repo,
        head: state.baselineHead,
        branch: state.baselineBranch,
      });
      if (fingerprint !== state.pausedWorktreeFingerprint) {
        throw new Error("Repository changed after the interrupt; resume refused and lease retained.");
      }
      await updateLease(state.repo, runId, "running", dataRoot);
      logEvent("run_resumed", { runId, response });
      try {
        await graph.invoke(
          resumeCommand({ response, message, validationCommands }),
          configFor(runId),
        );
        await settleInvocation(graph, runId, dataRoot, tui);
      } catch (error) {
        await removeLease(state.repo, runId, dataRoot).catch(() => undefined);
        throw error;
      }
    } finally {
      checkpointer.db.close();
    }
    }, dataRoot);
  } finally {
    stopInterface(tui);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const [command, ...args] = argv;
  if (!command || command.startsWith("--")) return await run(parseArgs(argv));
  const parsed = parseArgs(args);
  if (command === "run") return await run(parsed);
  if (command === "status") return await status(parsed);
  if (command === "resume") return await resume(parsed);
  usage();
}

loadAgentEnvironment();
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
