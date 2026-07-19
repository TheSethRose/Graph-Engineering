import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "bun:test";

const exec = promisify(execFile);

test("the compiled CLI prints complete help without starting a workflow", async () => {
  const { stdout, stderr } = await exec(process.execPath, ["dist/src/cli.js", "--help"]);

  assert.equal(stderr, "");
  assert.match(stdout, /agent-workflow \[--task TASK\]/);
  assert.match(stdout, /agent-workflow run \[--task TASK\]/);
  assert.match(stdout, /prompt for the task/);
  assert.match(stdout, /agent-workflow status RUN_ID/);
  assert.match(stdout, /agent-workflow resume RUN_ID --response RESPONSE/);
  assert.match(stdout, /--validation-timeout-seconds/);
  assert.match(stdout, /--verbose/);
  assert.match(stdout, /--trace/);
  assert.match(stdout, /--interactive/);
  assert.match(stdout, /--no-interactive/);
  assert.match(stdout, /current directory/);
  assert.match(stdout, /not human approval before editing/);
});

test("the bare command defaults to run and non-interactive use still requires a task", async () => {
  await assert.rejects(
    exec(process.execPath, ["dist/src/cli.js", "--no-interactive"]),
    /--task is required when interactive task entry is unavailable/,
  );
});

test("interactive overrides are mutually exclusive", async () => {
  await assert.rejects(
    exec(process.execPath, [
      "dist/src/cli.js",
      "run",
      "--task",
      "test conflicting flags",
      "--interactive",
      "--no-interactive",
    ]),
    /cannot be used together/,
  );
});
