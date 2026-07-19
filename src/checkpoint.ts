import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as z from "zod";
import { runCommand } from "./agents.js";

export type GitBaseline = { repo: string; head: string; branch: string };
export type RepositoryLease = {
  run_id: string;
  status: "running" | "waiting_for_human";
};
type Leases = Record<string, RepositoryLease>;
const LeasesSchema = z.record(
  z.string(),
  z.strictObject({
    run_id: z.string().min(1),
    status: z.enum(["running", "waiting_for_human"]),
  }),
);

export function getDataRoot(): string {
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "agent-workflow",
  );
}

export async function ensureDataRoot(dataRoot = getDataRoot()): Promise<string> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  return dataRoot;
}

export async function createCheckpointer(dataRoot = getDataRoot()): Promise<SqliteSaver> {
  await ensureDataRoot(dataRoot);
  return SqliteSaver.fromConnString(join(dataRoot, "checkpoints.sqlite3"));
}

async function git(repo: string, args: string[], maxBytes = 32 * 1024 * 1024): Promise<string> {
  const result = await runCommand("git", args, {
    cwd: repo,
    timeoutMs: 30_000,
    maxBytes,
    redactOutput: false,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  if (result.stdout.endsWith("\n[output truncated]")) {
    throw new Error(`git ${args.join(" ")} exceeded the ${maxBytes}-byte safety limit.`);
  }
  return result.stdout;
}

export async function preflightRepository(path: string): Promise<GitBaseline> {
  const absolute = resolve(path);
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Repository does not exist: ${absolute}`);
  const repo = await realpath(absolute);
  const root = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
  if ((await realpath(root)) !== repo) {
    throw new Error("--repo must name the root of an existing Git worktree.");
  }
  const status = await git(repo, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.length > 0) {
    throw new Error("Repository worktree is dirty; no workflow changes were made.");
  }
  const branch = (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  if (!branch) throw new Error("Repository is in detached HEAD state.");
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { repo, head, branch };
}

export async function assertGitInvariants(
  baseline: GitBaseline,
): Promise<string | undefined> {
  const head = (await git(baseline.repo, ["rev-parse", "HEAD"])).trim();
  const branch = (
    await git(baseline.repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  ).trim();
  if (head !== baseline.head || branch !== baseline.branch) {
    return `Git boundary violation: expected ${baseline.branch}@${baseline.head}, found ${branch || "detached HEAD"}@${head}.`;
  }
  return undefined;
}

export async function changedFiles(repo: string): Promise<string[]> {
  const raw = await git(repo, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const records = raw.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const statusCode = record.slice(0, 2);
    paths.push(record.slice(3));
    if (statusCode.includes("R") || statusCode.includes("C")) index += 1;
  }
  return [...new Set(paths)].sort();
}

async function hashPath(repo: string, relativePath: string): Promise<string> {
  const path = join(repo, relativePath);
  const info = await lstat(path);
  const content = info.isSymbolicLink()
    ? Buffer.from(await readlink(path))
    : await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

export async function worktreeFingerprint(baseline: GitBaseline): Promise<string> {
  const invariant = await assertGitInvariants(baseline);
  if (invariant) throw new Error(invariant);
  const [diff, lsFiles] = await Promise.all([
    git(baseline.repo, ["diff", "--binary", "HEAD"]),
    git(baseline.repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const untracked = lsFiles.split("\0").filter(Boolean).sort();
  const untrackedHashes = await Promise.all(
    untracked.map(async (path) => `${path}\0${await hashPath(baseline.repo, path)}`),
  );
  return createHash("sha256")
    .update(`${baseline.head}\0${baseline.branch}\0${diff}\0${untrackedHashes.join("\0")}`)
    .digest("hex");
}

export async function worktreeEvidence(repo: string): Promise<string> {
  const [status, diff] = await Promise.all([
    git(repo, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    git(repo, ["diff", "--stat", "HEAD"]),
  ]);
  return `${status}${diff}`.trim();
}

export async function reviewDiff(repo: string): Promise<string> {
  const [tracked, lsFiles] = await Promise.all([
    git(repo, ["diff", "--binary", "HEAD"]),
    git(repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  const untracked = lsFiles.split("\0").filter(Boolean).sort();
  const additions = await Promise.all(
    untracked.map(async (path) => {
      const result = await runCommand(
        "git",
        ["diff", "--no-index", "--binary", "--", "/dev/null", path],
        { cwd: repo, timeoutMs: 30_000, maxBytes: 512 * 1024, redactOutput: false },
      );
      if (![0, 1].includes(result.exitCode ?? -1) || result.timedOut) {
        throw new Error(`Could not render untracked diff for ${path}: ${result.stderr}`);
      }
      return result.stdout;
    }),
  );
  const value = `${tracked}${additions.join("")}`;
  const bytes = Buffer.from(value);
  return bytes.length <= 512 * 1024
    ? value
    : `${bytes.subarray(0, 512 * 1024).toString("utf8")}\n[review diff truncated]`;
}

export async function withProcessLock<T>(
  action: () => Promise<T>,
  dataRoot = getDataRoot(),
): Promise<T> {
  await ensureDataRoot(dataRoot);
  const lockPath = join(dataRoot, "agent-workflow.lock");
  let handle;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
      let live = Number.isInteger(pid);
      if (live) {
        try {
          process.kill(pid, 0);
        } catch (killError) {
          live = (killError as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (live) throw new Error(`Another agent-workflow writer is active (PID ${pid}).`, { cause: error });
      await unlink(lockPath);
    }
  }
  if (!handle) throw new Error("Could not acquire the agent-workflow process lock.");
  try {
    return await action();
  } finally {
    await handle.close();
    const owner = await readFile(lockPath, "utf8").catch(() => "");
    if (owner.trim() === String(process.pid)) await unlink(lockPath).catch(() => undefined);
  }
}

async function readLeases(dataRoot: string): Promise<Leases> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dataRoot, "active-runs.json"), "utf8"));
    return LeasesSchema.parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("active-runs.json is malformed; refusing to alter repository leases.", { cause: error });
  }
}

async function writeLeases(dataRoot: string, leases: Leases): Promise<void> {
  await ensureDataRoot(dataRoot);
  const path = join(dataRoot, "active-runs.json");
  const temporary = join(dirname(path), `active-runs.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(leases, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function createLease(
  repo: string,
  runId: string,
  dataRoot = getDataRoot(),
): Promise<void> {
  const leases = await readLeases(dataRoot);
  if (leases[repo]) {
    throw new Error(`Repository is already leased by run ${leases[repo].run_id}.`);
  }
  leases[repo] = { run_id: runId, status: "running" };
  await writeLeases(dataRoot, leases);
}

export async function getLease(
  repo: string,
  dataRoot = getDataRoot(),
): Promise<RepositoryLease | undefined> {
  return (await readLeases(dataRoot))[repo];
}

export async function updateLease(
  repo: string,
  runId: string,
  status: RepositoryLease["status"],
  dataRoot = getDataRoot(),
): Promise<void> {
  const leases = await readLeases(dataRoot);
  if (leases[repo]?.run_id !== runId) throw new Error("Repository lease does not belong to this run.");
  leases[repo] = { run_id: runId, status };
  await writeLeases(dataRoot, leases);
}

export async function removeLease(
  repo: string,
  runId: string,
  dataRoot = getDataRoot(),
): Promise<void> {
  const leases = await readLeases(dataRoot);
  if (leases[repo]?.run_id === runId) {
    delete leases[repo];
    await writeLeases(dataRoot, leases);
  }
}

export function logEvent(event: string, fields: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}
