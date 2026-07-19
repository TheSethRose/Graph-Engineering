import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertGitInvariants,
  preflightRepository,
} from "../src/checkpoint.js";
import { loadWorkflowConfig, runValidationCommand } from "../src/validation.js";

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

test("repository preflight accepts only a clean named-branch root", async () => {
  const repo = await repository();
  try {
    const baseline = await preflightRepository(repo);
    assert.equal(baseline.branch, "main");
    assert.equal(baseline.repo, await realpath(repo));

    await writeFile(join(repo, "dirty.txt"), "dirty\n");
    await assert.rejects(preflightRepository(repo), /worktree is dirty/);
    await rm(join(repo, "dirty.txt"));

    await exec("git", ["checkout", "--detach"], { cwd: repo });
    await assert.rejects(preflightRepository(repo), /symbolic-ref|detached/i);
  } finally {
    await rm(repo, { recursive: true, force: true });
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

test("validation executes trusted shell commands and preserves the exit contract", async () => {
  const repo = await repository();
  try {
    const passed = await runValidationCommand(
      "test -f tracked.txt && printf shell-ok",
      repo,
      2_000,
    );
    assert.equal(passed.exitCode, 0);
    assert.equal(passed.stdout, "shell-ok");
    assert.deepEqual(passed.argv, [
      "/bin/sh",
      "-lc",
      "test -f tracked.txt && printf shell-ok",
    ]);

    const failed = await runValidationCommand("exit 9", repo, 2_000);
    assert.equal(failed.exitCode, 9);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
