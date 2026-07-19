import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { runCommand } from "./agents.js";
import type { CommandResult } from "./state.js";

const RepoConfigSchema = z.strictObject({
  max_attempts: z.number().int().positive().default(3),
  review_required: z.boolean().default(false),
  research_mode: z.enum(["auto", "off"]).default("auto"),
  hermes_timeout_seconds: z.number().int().positive().default(1_800),
  codex_timeout_seconds: z.number().int().positive().default(3_600),
  validation_timeout_seconds: z.number().int().positive().default(1_800),
  validation_commands: z.array(z.string().min(1)).default([]),
});

export type WorkflowConfig = {
  maxAttempts: number;
  reviewRequired: boolean;
  researchMode: "auto" | "off";
  hermesTimeoutMs: number;
  codexTimeoutMs: number;
  validationTimeoutMs: number;
  validationCommands: string[];
  validationSource?: "cli" | "repo_config";
};

export type ConfigOverrides = Partial<
  Omit<WorkflowConfig, "validationCommands" | "validationSource">
> & { validationCommands?: string[] };

async function trackedConfig(repo: string): Promise<z.infer<typeof RepoConfigSchema> | undefined> {
  const canonicalRepo = await realpath(repo);
  const path = join(canonicalRepo, ".agent-workflow.json");
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(".agent-workflow.json must be a regular, non-symlinked file.");
    }
    const resolved = await realpath(path);
    if (resolved !== path) throw new Error(".agent-workflow.json must not resolve through a symlink.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const tracked = await runCommand(
    "git",
    ["ls-files", "--error-unmatch", "--", ".agent-workflow.json"],
    { cwd: canonicalRepo, timeoutMs: 10_000 },
  );
  if (tracked.exitCode !== 0) {
    throw new Error(".agent-workflow.json exists but is not Git-tracked.");
  }
  try {
    return RepoConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Invalid .agent-workflow.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadWorkflowConfig(
  repo: string,
  overrides: ConfigOverrides,
): Promise<WorkflowConfig> {
  const file = await trackedConfig(repo);
  const config = file ?? RepoConfigSchema.parse({});
  const cliCommands = overrides.validationCommands?.map((value) => value.trim());
  if (cliCommands?.some((value) => value.length === 0)) {
    throw new Error("Validation commands must not be empty.");
  }
  const validationCommands = cliCommands ?? config.validation_commands;
  return {
    maxAttempts: overrides.maxAttempts ?? config.max_attempts,
    reviewRequired: overrides.reviewRequired ?? config.review_required,
    researchMode: overrides.researchMode ?? config.research_mode,
    hermesTimeoutMs:
      overrides.hermesTimeoutMs ?? config.hermes_timeout_seconds * 1_000,
    codexTimeoutMs: overrides.codexTimeoutMs ?? config.codex_timeout_seconds * 1_000,
    validationTimeoutMs:
      overrides.validationTimeoutMs ?? config.validation_timeout_seconds * 1_000,
    validationCommands,
    ...(validationCommands.length > 0
      ? { validationSource: cliCommands ? ("cli" as const) : ("repo_config" as const) }
      : {}),
  };
}

export async function runValidationCommand(
  command: string,
  repo: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return await runCommand("/bin/sh", ["-lc", command], {
    cwd: repo,
    timeoutMs,
    recordedArgv: ["/bin/sh", "-lc", command],
  });
}
