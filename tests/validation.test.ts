import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { promisify } from "node:util";
import {
  assertGitInvariants,
  createLease,
  createWorkflowWorkspace,
  discardWorkflowWorkspace,
  getLease,
  preflightRepository,
  reconcileWorkflowWorkspace,
  workspaceChangedFiles,
} from "../src/checkpoint.js";
import {
  isValidationEnvironmentFailure,
  loadWorkflowConfig,
  runValidationCommand,
  trustedAgentValidationCommands,
} from "../src/validation.js";

const exec = promisify(execFile);

async function repository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "agent-workflow-repo-"));
  await exec("git", ["init", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await exec("git", ["config", "user.name", "Test"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "initial\n");
  await exec("git", ["add", "tracked.txt"], { cwd: repo });
  await exec("git", ["commit", "-m", "initial"], { cwd: repo });
  return repo;
}

test("repository preflight accepts dirty named-branch roots", async () => {
  const repo = await repository();
  try {
    const baseline = await preflightRepository(repo);
    assert.equal(baseline.branch, "main");
    assert.equal(baseline.repo, await realpath(repo));

    await writeFile(join(repo, "dirty.txt"), "dirty\n");
    assert.equal((await preflightRepository(repo)).branch, "main");
    await rm(join(repo, "dirty.txt"));

    await exec("git", ["checkout", "--detach"], { cwd: repo });
    await assert.rejects(preflightRepository(repo), /symbolic-ref|detached/i);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("isolated workspaces preserve dirty source changes and apply only the workflow delta", async () => {
  const repo = await repository();
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-workspace-"));
  const dataRoot = join(root, "data");
  let workspace: Awaited<ReturnType<typeof createWorkflowWorkspace>> | undefined;
  try {
    await writeFile(join(repo, "tracked.txt"), "user baseline\n");
    await writeFile(join(repo, "untracked.txt"), "user file\n");
    workspace = await createWorkflowWorkspace(await preflightRepository(repo), "workspace-test", dataRoot);

    assert.equal(await readFile(join(workspace.repo, "tracked.txt"), "utf8"), "user baseline\n");
    assert.equal(await readFile(join(workspace.repo, "untracked.txt"), "utf8"), "user file\n");
    assert.deepEqual(await workspaceChangedFiles(workspace.repo, workspace.indexPath), []);

    await writeFile(join(workspace.repo, "tracked.txt"), "workflow result\n");
    await writeFile(join(workspace.repo, "added.txt"), "added by workflow\n");
    assert.deepEqual(
      await workspaceChangedFiles(workspace.repo, workspace.indexPath),
      ["added.txt", "tracked.txt"],
    );
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "user baseline\n");

    const applied = await reconcileWorkflowWorkspace(repo, workspace.repo, workspace.indexPath);
    assert.deepEqual(applied, ["added.txt", "tracked.txt"]);
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "workflow result\n");
    assert.equal(await readFile(join(repo, "untracked.txt"), "utf8"), "user file\n");
    assert.equal(await readFile(join(repo, "added.txt"), "utf8"), "added by workflow\n");
    await assert.rejects(access(workspace.repo));
    workspace = undefined;
  } finally {
    if (workspace) {
      await discardWorkflowWorkspace(repo, workspace.repo, workspace.indexPath).catch(() => undefined);
    }
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace reconciliation preserves the workspace when source edits conflict", async () => {
  const repo = await repository();
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-conflict-"));
  const dataRoot = join(root, "data");
  const workspace = await createWorkflowWorkspace(
    await preflightRepository(repo),
    "conflict-test",
    dataRoot,
  );
  try {
    await writeFile(join(workspace.repo, "tracked.txt"), "workflow edit\n");
    await writeFile(join(repo, "tracked.txt"), "outside edit\n");
    await assert.rejects(
      reconcileWorkflowWorkspace(repo, workspace.repo, workspace.indexPath),
      /workspace preserved/,
    );
    await access(workspace.repo);
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "outside edit\n");
  } finally {
    await discardWorkflowWorkspace(repo, workspace.repo, workspace.indexPath).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("dead running leases are reclaimed but paused leases remain protected", async () => {
  const repo = await repository();
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-lease-"));
  const dataRoot = join(root, "data");
  try {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(
      join(dataRoot, "active-runs.json"),
      JSON.stringify({
        [await realpath(repo)]: {
          run_id: "dead-run",
          status: "running",
          pid: 2_147_483_647,
        },
      }),
    );
    assert.equal(await createLease(await realpath(repo), "replacement", dataRoot), "dead-run");
    assert.equal((await getLease(await realpath(repo), dataRoot))?.run_id, "replacement");

    await writeFile(
      join(dataRoot, "active-runs.json"),
      JSON.stringify({
        [await realpath(repo)]: { run_id: "paused-run", status: "waiting_for_human" },
      }),
    );
    await assert.rejects(
      createLease(await realpath(repo), "other", dataRoot),
      /already leased by run paused-run/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("repository invariants detect branch and HEAD changes", async () => {
  const repo = await repository();
  try {
    const baseline = await preflightRepository(repo);
    assert.equal(await assertGitInvariants(baseline), undefined);

    await exec("git", ["checkout", "-b", "unexpected-branch"], { cwd: repo });
    assert.match(
      (await assertGitInvariants(baseline)) ?? "",
      /Git boundary violation.*unexpected-branch/,
    );

    await exec("git", ["checkout", "main"], { cwd: repo });
    await writeFile(join(repo, "tracked.txt"), "changed and committed\n");
    await exec("git", ["add", "tracked.txt"], { cwd: repo });
    await exec("git", ["commit", "-m", "unexpected commit"], { cwd: repo });
    assert.match(
      (await assertGitInvariants(baseline)) ?? "",
      /Git boundary violation/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("tracked JSON configuration is validated and CLI commands replace it", async () => {
  const repo = await repository();
  try {
    await writeFile(
      join(repo, ".agent-workflow.json"),
      JSON.stringify({ validation_commands: ["npm test"], max_attempts: 2 }),
    );
    await assert.rejects(loadWorkflowConfig(repo, {}), /not Git-tracked/);
    await exec("git", ["add", ".agent-workflow.json"], { cwd: repo });
    await exec("git", ["commit", "-m", "config"], { cwd: repo });

    const fromFile = await loadWorkflowConfig(repo, {});
    assert.deepEqual(fromFile.validationCommands, ["npm test"]);
    assert.equal(fromFile.validationSource, "repo_config");
    assert.equal(fromFile.maxAttempts, 2);

    const fromCli = await loadWorkflowConfig(repo, {
      validationCommands: ["npm run typecheck"],
      maxAttempts: 4,
    });
    assert.deepEqual(fromCli.validationCommands, ["npm run typecheck"]);
    assert.equal(fromCli.validationSource, "cli");
    assert.equal(fromCli.maxAttempts, 4);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("planner validation is trusted only when copied from tracked AGENTS.md command sections", async () => {
  const repo = await repository();
  try {
    await writeFile(
      join(repo, "AGENTS.md"),
      `# Instructions

## Setup and Validation

- Run the focused checks with \`bun run typecheck\` and \`bun test\`.
- Never run \`rm -rf generated\`.

\`\`\`sh
bun run lint
# explanatory comment
\`\`\`

## Safety

- Never run \`git reset --hard\`.
`,
    );
    await assert.rejects(
      trustedAgentValidationCommands(repo, ["bun test"]),
      /not Git-tracked/,
    );
    await exec("git", ["add", "AGENTS.md"], { cwd: repo });
    await exec("git", ["commit", "-m", "instructions"], { cwd: repo });

    assert.deepEqual(
      await trustedAgentValidationCommands(repo, [
        " bun test ",
        "bun run lint",
        "rm -rf generated",
        "git reset --hard",
        "bun run undocumented",
        "bun test",
      ]),
      ["bun test", "bun run lint"],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("validation executes trusted shell commands and preserves the exit contract", async () => {
  const repo = await repository();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `/tmp/agent-workflow-node-24:${originalPath ?? ""}`;
    const passed = await runValidationCommand(
      "test -f tracked.txt && printf shell-ok",
      repo,
      2_000,
    );
    assert.equal(passed.exitCode, 0);
    assert.equal(passed.stdout, "shell-ok");
    assert.deepEqual(passed.argv, [
      "/bin/sh",
      "-c",
      "test -f tracked.txt && printf shell-ok",
    ]);

    const failed = await runValidationCommand("exit 9", repo, 2_000);
    assert.equal(failed.exitCode, 9);

    const inherited = await runValidationCommand("printf %s \"$PATH\"", repo, 2_000);
    assert.equal(inherited.stdout, process.env.PATH);

    assert.equal(
      isValidationEnvironmentFailure({
        ...failed,
        stderr: "better_sqlite3.node was compiled against a different Node.js version; NODE_MODULE_VERSION 137",
      }),
      true,
    );
    assert.equal(isValidationEnvironmentFailure(failed), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(repo, { recursive: true, force: true });
  }
});
