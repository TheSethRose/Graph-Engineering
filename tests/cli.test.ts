import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);

test("the compiled CLI prints complete help without starting a workflow", async () => {
  const { stdout, stderr } = await exec(process.execPath, ["dist/src/cli.js", "--help"]);

  assert.equal(stderr, "");
  assert.match(stdout, /agent-workflow run --repo PATH --task TASK/);
  assert.match(stdout, /agent-workflow status RUN_ID/);
  assert.match(stdout, /agent-workflow resume RUN_ID --response RESPONSE/);
  assert.match(stdout, /--validation-timeout-seconds/);
  assert.match(stdout, /not human approval before editing/);
});
