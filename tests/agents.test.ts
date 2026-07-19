import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  loadAgentEnvironment,
  redact,
  runCodex,
  runCommand,
  runHermes,
  setCommandTracing,
} from "../src/agents.js";

test("agent executable paths load from an explicit env file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-env-"));
  const path = join(root, ".env");
  const originalHermes = process.env.HERMES_PATH;
  const originalCodex = process.env.CODEX_PATH;
  try {
    delete process.env.HERMES_PATH;
    delete process.env.CODEX_PATH;
    await writeFile(path, "HERMES_PATH=/custom/hermes\nCODEX_PATH=/custom/codex\n");
    loadAgentEnvironment(path);
    assert.equal(process.env.HERMES_PATH, "/custom/hermes");
    assert.equal(process.env.CODEX_PATH, "/custom/codex");
  } finally {
    if (originalHermes === undefined) delete process.env.HERMES_PATH;
    else process.env.HERMES_PATH = originalHermes;
    if (originalCodex === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = originalCodex;
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand captures success, failure, missing executables, timeout, and truncation", async () => {
  const success = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], {
    cwd: process.cwd(),
    timeoutMs: 2_000,
  });
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout, "ok");

  const failure = await runCommand(process.execPath, ["-e", "process.stderr.write('bad');process.exit(7)"], {
    cwd: process.cwd(),
    timeoutMs: 2_000,
  });
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.stderr, "bad");

  const missing = await runCommand(`missing-agent-workflow-${Date.now()}`, [], {
    cwd: process.cwd(),
    timeoutMs: 2_000,
  });
  assert.equal(missing.exitCode, null);
  assert.match(missing.stderr, /ENOENT/);

  const timeout = await runCommand(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], {
    cwd: process.cwd(),
    timeoutMs: 20,
  });
  assert.equal(timeout.timedOut, true);

  const truncated = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000))"], {
    cwd: process.cwd(),
    timeoutMs: 2_000,
    maxBytes: 10,
  });
  assert.match(truncated.stdout, /output truncated/);
  assert.equal(redact("token=abc123456 secret: hidden-value"), "token=[REDACTED] secret: [REDACTED]");
});

test("verbose command tracing shows redacted commands, output, and completion", async () => {
  const originalWrite = process.stderr.write;
  let trace = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    trace += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  setCommandTracing(true);
  try {
    await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('token=hidden-value\\nfinished')"],
      { cwd: process.cwd(), timeoutMs: 2_000, traceLabel: "test" },
    );
  } finally {
    setCommandTracing(false);
    process.stderr.write = originalWrite;
  }

  assert.match(trace, /"event":"command_start"/);
  assert.match(trace, /"label":"test"/);
  assert.match(trace, /token=\[REDACTED\]/);
  assert.doesNotMatch(trace, /hidden-value/);
  assert.match(trace, /"event":"command_complete"/);
});

test("runCommand terminates descendant processes when it times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-process-group-"));
  const marker = join(root, "orphan.txt");
  const childScript = `
const { spawn } = require("node:child_process");
spawn(process.execPath, [
  "-e",
  "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 300)",
  process.argv[1],
], { stdio: "ignore" });
setTimeout(() => {}, 10_000);
`;
  try {
    const result = await runCommand(process.execPath, ["-e", childScript, marker], {
      cwd: root,
      timeoutMs: 20,
    });
    assert.equal(result.timedOut, true);
    await delay(400);
    await assert.rejects(access(marker), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand terminates descendants when its parent receives SIGINT", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-interrupt-"));
  const marker = join(root, "orphan.txt");
  const agentsUrl = new URL("../src/agents.js", import.meta.url).href;
  const childScript = `
import { runCommand } from ${JSON.stringify(agentsUrl)};
await runCommand(process.execPath, [
  "-e",
  "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 500)",
  ${JSON.stringify(marker)},
], { cwd: ${JSON.stringify(root)}, timeoutMs: 10_000 }).catch(() => { process.exitCode = 130; });
`;
  try {
    const parent = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      stdio: "ignore",
    });
    await delay(100);
    parent.kill("SIGINT");
    await new Promise<void>((resolve) => parent.once("close", () => resolve()));
    await delay(600);
    await assert.rejects(access(marker), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hermes output is strict JSON and malformed output is a recoverable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-hermes-"));
  const bin = join(root, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const hermes = join(bin, "hermes");
  const originalPath = process.env.PATH;
  const originalHermes = process.env.HERMES_PATH;
  try {
    await writeFile(
      hermes,
      `#!/usr/bin/env node
const prompt = process.argv.at(-1);
if (prompt.includes("read-only planner")) process.stdout.write(JSON.stringify({plan:"plan",research_required:false,research_reason:"",review_required:false,review_reason:"",validation_coverage_complete:true,validation_commands:["npm test"]}));
else process.stdout.write("not json");
`,
    );
    await chmod(hermes, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.HERMES_PATH = hermes;
    const planned = await runHermes("read-only planner", root, 2_000, "planner");
    assert.equal(planned.result.exitCode, 0);
    assert.equal(planned.output && "plan" in planned.output ? planned.output.plan : undefined, "plan");
    const malformed = await runHermes("research", root, 2_000, "research");
    assert.equal(malformed.output, undefined);
    assert.equal(malformed.result.exitCode, null);
    assert.match(malformed.result.stderr, /Malformed research output/);
  } finally {
    process.env.PATH = originalPath;
    if (originalHermes === undefined) delete process.env.HERMES_PATH;
    else process.env.HERMES_PATH = originalHermes;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex invocation retains sandboxing and explicit network/search overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-workflow-codex-"));
  const bin = join(root, "bin");
  const data = join(root, "data");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  const codex = join(bin, "codex");
  const originalPath = process.env.PATH;
  const originalCodex = process.env.CODEX_PATH;
  try {
    await writeFile(
      codex,
      `#!/usr/bin/env node
const fs = await import("node:fs/promises");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output-last-message") + 1];
await fs.writeFile(output, JSON.stringify({summary:args.join("|")}));
`,
    );
    await chmod(codex, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.CODEX_PATH = codex;
    const call = await runCodex("implement", root, 2_000, data);
    assert.equal(call.result.exitCode, 0);
    assert.match(call.summary ?? "", /--sandbox\|workspace-write/);
    assert.match(call.summary ?? "", /^--ask-for-approval\|never\|exec/);
    assert.match(call.summary ?? "", /sandbox_workspace_write\.network_access=false/);
    assert.match(call.summary ?? "", /web_search="disabled"/);
    assert.doesNotMatch(call.summary ?? "", /dangerously-bypass/);
  } finally {
    process.env.PATH = originalPath;
    if (originalCodex === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = originalCodex;
    await rm(root, { recursive: true, force: true });
  }
});
