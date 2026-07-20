import assert from "node:assert/strict";
import { test } from "bun:test";
import { renderTui } from "../src/tui.js";

test("the TUI renders compact run state and only the latest events", () => {
  const output = renderTui({
    runId: "run-123",
    node: "coder",
    attempt: 2,
    elapsedMs: 65_000,
    lines: Array.from({ length: 12 }, (_, index) => `event ${index}`),
    footer: "[p] pause",
  });

  assert.match(output, /agent-workflow · run-123/);
  assert.match(output, /coder · attempt 2 · 1m 5s/);
  assert.doesNotMatch(output, /event 0/);
  assert.match(output, /event 11/);
  assert.match(output, /\[p\] pause/);

  const resized = renderTui({
    runId: "run-123",
    node: "coder",
    attempt: 2,
    elapsedMs: 0,
    lines: ["first", "second", "third"],
    footer: "ready",
    rows: 7,
    columns: 80,
  });
  assert.doesNotMatch(resized, /first/);
  assert.match(resized, /second/);
  assert.match(resized, /third/);
});
