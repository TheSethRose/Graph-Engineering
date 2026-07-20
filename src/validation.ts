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
  validationSource?: "cli" | "repo_config" | "agents";
};

export type ConfigOverrides = Partial<
  Omit<WorkflowConfig, "validationCommands" | "validationSource">
> & { validationCommands?: string[] };

async function trackedOrUnborn(repo: string, path: string): Promise<boolean> {
  const tracked = await runCommand(
    "git",
    ["ls-files", "--error-unmatch", "--", path],
    { cwd: repo, timeoutMs: 10_000 },
  );
  if (tracked.exitCode === 0) return true;
  const head = await runCommand("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repo,
    timeoutMs: 10_000,
  });
  return head.exitCode === 128 && /Needed a single revision/i.test(head.stderr);
}

export function isValidationEnvironmentFailure(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    result.exitCode === 127 ||
    /compiled against a different Node\.js version|NODE_MODULE_VERSION\s+\d+|npm warn EBADENGINE\s+Unsupported engine/i.test(
      output,
    )
  );
}

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
  if (!(await trackedOrUnborn(canonicalRepo, ".agent-workflow.json"))) {
    throw new Error(".agent-workflow.json exists but is not Git-tracked in a repository with commits.");
  }
  try {
    return RepoConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `Invalid .agent-workflow.json: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

const VALIDATION_HEADING = /\b(?:setup|install|build|tests?|testing|validation|validate|checks?|quality)\b/i;
const NEGATED_COMMAND = /\b(?:do not|don't|never|avoid)\b/i;

function documentedValidationCommands(markdown: string): Set<string> {
  const commands = new Set<string>();
  const sectionLevels = new Map<number, boolean>();
  let relevantSection = false;
  let inFence = false;
  let trustedFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      if (inFence) {
        inFence = false;
        trustedFence = false;
      } else {
        inFence = true;
        trustedFence =
          relevantSection && /^(?:|sh|shell|bash|zsh)$/.test(fence[1]?.toLowerCase() ?? "");
      }
      continue;
    }

    if (inFence) {
      const command = line.trim();
      if (trustedFence && command && !command.startsWith("#")) commands.add(command);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      for (const existing of [...sectionLevels.keys()]) {
        if (existing >= level) sectionLevels.delete(existing);
      }
      const parentRelevant = [...sectionLevels.values()].some(Boolean);
      relevantSection = parentRelevant || VALIDATION_HEADING.test(heading[2]!);
      sectionLevels.set(level, relevantSection);
      continue;
    }

    if (!relevantSection || NEGATED_COMMAND.test(line)) continue;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const command = match[1]!.trim();
      if (command) commands.add(command);
    }
  }

  return commands;
}

export async function trustedAgentValidationCommands(
  repo: string,
  suggestions: string[],
): Promise<string[]> {
  const canonicalRepo = await realpath(repo);
  const path = join(canonicalRepo, "AGENTS.md");
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("AGENTS.md must be a regular, non-symlinked file.");
    }
    if ((await realpath(path)) !== path) {
      throw new Error("AGENTS.md must not resolve through a symlink.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  if (!(await trackedOrUnborn(canonicalRepo, "AGENTS.md"))) {
    throw new Error("AGENTS.md exists but is not Git-tracked in a repository with commits.");
  }

  const documented = documentedValidationCommands(await readFile(path, "utf8"));
  return [...new Set(suggestions.map((command) => command.trim()))].filter((command) =>
    documented.has(command),
  );
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
  return await runCommand("/bin/sh", ["-c", command], {
    cwd: repo,
    timeoutMs,
    recordedArgv: ["/bin/sh", "-c", command],
    traceLabel: "validation",
  });
}
