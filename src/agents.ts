import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { OUTPUT_LIMIT_BYTES, type CommandResult } from "./state.js";

type RunOptions = {
  cwd: string;
  timeoutMs: number;
  recordedArgv?: string[];
  maxBytes?: number;
  redactOutput?: boolean;
};

function capped(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}\n[output truncated]`;
}

export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}

export function loadAgentEnvironment(
  path = fileURLToPath(new URL("../../.env", import.meta.url)),
): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function agentExecutable(name: "HERMES_PATH" | "CODEX_PATH", fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export async function runCommand(
  executable: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  const started = performance.now();
  const maxBytes = options.maxBytes ?? OUTPUT_LIMIT_BYTES;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: Error | undefined;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (Buffer.byteLength(stdout) <= maxBytes) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) <= maxBytes) stderr += chunk;
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    let forceKillTimer: NodeJS.Timeout | undefined;
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          spawnError = error instanceof Error ? error : new Error(String(error));
          child.kill(signal);
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      forceKillTimer = setTimeout(() => killProcessGroup("SIGKILL"), 1_000);
      forceKillTimer.unref();
    }, options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        argv: options.recordedArgv ?? [executable, ...args],
        exitCode: spawnError ? null : code,
        stdout: options.redactOutput === false ? capped(stdout, maxBytes) : redact(capped(stdout, maxBytes)),
        stderr: (options.redactOutput === false ? (value: string) => value : redact)(
          capped(
            spawnError ? `${stderr}\n${spawnError.message}`.trim() : stderr,
            maxBytes,
          ),
        ),
        timedOut,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      });
    });
  });
}

const PlannerOutputSchema = z.strictObject({
  plan: z.string().min(1),
  research_required: z.boolean(),
  research_reason: z.string(),
  review_required: z.boolean(),
  review_reason: z.string(),
  validation_coverage_complete: z.boolean(),
  validation_commands: z.array(z.string()),
});

const ResearchOutputSchema = z.strictObject({ findings: z.string().min(1) });
const ReviewOutputSchema = z.strictObject({
  decision: z.enum(["approved", "changes_requested", "human_required"]),
  findings: z.string(),
});
const CodexOutputSchema = z.strictObject({ summary: z.string().min(1) });

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

function parseJson<T>(schema: z.ZodType<T>, text: string): T {
  return schema.parse(JSON.parse(text.trim()));
}

export async function runHermes(
  prompt: string,
  repo: string,
  timeoutMs: number,
  kind: "planner" | "research" | "reviewer",
): Promise<{
  result: CommandResult;
  output?: PlannerOutput | ResearchOutput | ReviewOutput;
}> {
  const executable = agentExecutable("HERMES_PATH", "hermes");
  const result = await runCommand(executable, ["-z", prompt], {
    cwd: repo,
    timeoutMs,
    recordedArgv: [executable, "-z", "<prompt>"],
  });
  if (result.exitCode !== 0 || result.timedOut) return { result };
  try {
    const output =
      kind === "planner"
        ? parseJson(PlannerOutputSchema, result.stdout)
        : kind === "research"
          ? parseJson(ResearchOutputSchema, result.stdout)
          : parseJson(ReviewOutputSchema, result.stdout);
    return { result, output };
  } catch (error) {
    return {
      result: {
        ...result,
        exitCode: null,
        stderr: `Malformed ${kind} output: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export async function runCodex(
  prompt: string,
  repo: string,
  timeoutMs: number,
  dataRoot: string,
): Promise<{ result: CommandResult; summary?: string }> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(dataRoot, "codex-"));
  const schemaPath = join(tempDir, "result.schema.json");
  const outputPath = join(tempDir, "result.json");
  await writeFile(
    schemaPath,
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    }),
    { mode: 0o600 },
  );
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--cd",
    repo,
    "--sandbox",
    "workspace-write",
    "--strict-config",
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    'web_search="disabled"',
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    prompt,
  ];
  try {
    const executable = agentExecutable("CODEX_PATH", "codex");
    const result = await runCommand(executable, args, {
      cwd: repo,
      timeoutMs,
      recordedArgv: [
        executable,
        "--ask-for-approval",
        "never",
        "exec",
        "--cd",
        repo,
        "--sandbox",
        "workspace-write",
        "--strict-config",
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        'web_search="disabled"',
        "--output-schema",
        "<schema>",
        "--output-last-message",
        "<output>",
        "<prompt>",
      ],
    });
    if (result.exitCode !== 0 || result.timedOut) return { result };
    try {
      const output = parseJson(CodexOutputSchema, await readFile(outputPath, "utf8"));
      return { result, summary: output.summary };
    } catch (error) {
      return {
        result: {
          ...result,
          exitCode: null,
          stderr: `Malformed Codex output: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function checkCliCompatibility(cwd: string): Promise<void> {
  const hermesExecutable = agentExecutable("HERMES_PATH", "hermes");
  const codexExecutable = agentExecutable("CODEX_PATH", "codex");
  const hermes = await runCommand(hermesExecutable, ["--help"], {
    cwd,
    timeoutMs: 10_000,
  });
  if (hermes.exitCode !== 0 || !`${hermes.stdout}\n${hermes.stderr}`.includes("-z")) {
    throw new Error("Hermes CLI is missing or does not support the required -z flag.");
  }
  const codexGlobal = await runCommand(codexExecutable, ["--help"], {
    cwd,
    timeoutMs: 10_000,
  });
  const globalHelp = `${codexGlobal.stdout}\n${codexGlobal.stderr}`;
  if (codexGlobal.exitCode !== 0 || !globalHelp.includes("--ask-for-approval")) {
    throw new Error("Codex CLI is missing or does not support the required --ask-for-approval flag.");
  }
  const codex = await runCommand(codexExecutable, ["exec", "--help"], {
    cwd,
    timeoutMs: 10_000,
  });
  const help = `${codex.stdout}\n${codex.stderr}`;
  for (const flag of [
    "--cd",
    "--sandbox",
    "--strict-config",
    "--output-schema",
    "--output-last-message",
  ]) {
    if (codex.exitCode !== 0 || !help.includes(flag)) {
      throw new Error(`Codex CLI is missing or does not support the required ${flag} flag.`);
    }
  }
}
