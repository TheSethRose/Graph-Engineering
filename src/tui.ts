import type { WorkflowEvent } from "./events.js";
import type { WorkflowStateValue } from "./state.js";

type PauseResponse = { response: "continue" | "revise" | "abort"; message: string };

export type TuiView = {
  runId: string;
  node: string;
  attempt: number;
  elapsedMs: number;
  lines: string[];
  footer: string;
};

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function renderTui(view: TuiView): string {
  const body = view.lines.slice(-10);
  return [
    `agent-workflow · ${view.runId || "starting"}`,
    `${view.node || "preflight"} · attempt ${view.attempt} · ${duration(view.elapsedMs)}`,
    "",
    ...(body.length > 0 ? body : ["Waiting for the first workflow event…"]),
    "",
    view.footer,
  ].join("\n");
}

export class WorkflowTui {
  private readonly startedAt = performance.now();
  private readonly lines: string[] = [];
  private runId = "";
  private node = "";
  private attempt = 1;
  private footer = "[p] pause after node  [t] raw trace  [Ctrl-C] cancel";
  private pauseRequested = false;
  private traceEnabled: boolean;
  private waiting = false;
  private inputMode: "task" | "guidance" | undefined;
  private inputText = "";
  private taskResponse: ((task: string) => void) | undefined;
  private response: ((response: PauseResponse) => void) | undefined;
  private timer?: NodeJS.Timeout;
  private finalState?: WorkflowStateValue;
  private active = false;

  constructor(
    private readonly changeTrace: (full: boolean) => void,
    traceEnabled = false,
  ) {
    this.traceEnabled = traceEnabled;
  }

  start(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("--interactive requires a terminal.");
    }
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onInput);
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    this.active = true;
    this.timer = setInterval(() => this.draw(), 1_000);
    this.timer.unref();
    this.draw();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    process.stdin.off("data", this.onInput);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\u001b[?25h\u001b[?1049l");
    if (this.finalState) {
      const files = this.finalState.changedFiles.length;
      process.stdout.write(
        `Run ${this.finalState.runId}: ${this.finalState.status}, attempt ${this.finalState.attempt}, ${files} changed file${files === 1 ? "" : "s"}.\n`,
      );
    }
  }

  showFinal(state: WorkflowStateValue): void {
    this.finalState = state;
    this.node = state.status;
    this.attempt = state.attempt;
    this.add(
      state.status === "waiting_for_human"
        ? `Paused: ${state.humanReason}. Run status ${state.runId} for details.`
        : `Finished: ${state.status}.`,
    );
    this.footer = state.status === "waiting_for_human" ? "Paused safely; resume with the CLI." : "Done.";
    this.draw();
  }

  promptTask(): Promise<string> {
    this.inputMode = "task";
    this.inputText = "";
    this.footer = "Task: █";
    this.draw();
    return new Promise((resolve) => {
      this.taskResponse = resolve;
    });
  }

  readonly handleEvent = (entry: WorkflowEvent): void => {
    if (typeof entry.runId === "string") this.runId = entry.runId;
    if (typeof entry.attempt === "number") this.attempt = entry.attempt;
    const event = entry.event;
    if (event === "node_start" && typeof entry.node === "string") {
      this.node = entry.node;
      this.add(`Started ${entry.node}.`);
    } else if (event === "node_complete" && typeof entry.node === "string") {
      this.add(`Completed ${entry.node} in ${duration(Number(entry.durationMs ?? 0))}.`);
    } else if (event === "transition") {
      this.add(`${String(entry.node)} → ${String(entry.transition)}`);
    } else if (event === "command_start") {
      this.add(`Running ${String(entry.label)} (pid ${String(entry.pid)}).`);
    } else if (event === "command_running") {
      this.footer = `${String(entry.label)} running · ${duration(Number(entry.durationMs ?? 0))}  [p] pause after node  [t] trace`;
    } else if (event === "command_complete") {
      const outcome = entry.timedOut ? "timed out" : `exit ${String(entry.exitCode)}`;
      this.add(`${String(entry.label)} finished: ${outcome}.`);
      this.footer = "[p] pause after node  [t] raw trace  [Ctrl-C] cancel";
    } else if (event === "command_output" && this.traceEnabled) {
      this.add(`[${String(entry.label)}] ${String(entry.text)}`);
    } else if (event === "interrupt_created") {
      this.add(`Paused: ${String(entry.reason)}.`);
    }
    this.draw();
  };

  consumePauseRequest = (): boolean => {
    if (!this.pauseRequested) return false;
    this.pauseRequested = false;
    this.add("Pause reached at a safe node boundary.");
    return true;
  };

  waitForOperatorResponse(): Promise<PauseResponse> {
    this.waiting = true;
    this.footer = "[c] continue  [g] add guidance  [a] abort";
    this.draw();
    return new Promise((resolve) => {
      this.response = resolve;
    });
  }

  private readonly onInput = (input: string): void => {
    for (const key of input) {
      if (key === "\u0003") {
        if (this.waiting) {
          this.resolve({ response: "abort", message: "Operator cancelled the paused run." });
          return;
        }
        this.stop();
        process.kill(process.pid, "SIGINT");
        return;
      }
      if (this.inputMode) {
        if (key === "\r" || key === "\n") {
          const value = this.inputText.trim();
          if (value && this.inputMode === "task") this.resolveTask(value);
          else if (value) this.resolve({ response: "revise", message: value });
        } else if (key === "\u007f") {
          this.inputText = this.inputText.slice(0, -1);
        } else if (key >= " ") {
          this.inputText += key;
        }
        if (this.inputMode) {
          const label = this.inputMode === "task" ? "Task" : "Guidance";
          this.footer = `${label}: ${this.inputText}█`;
        }
        this.draw();
        continue;
      }
      if (this.waiting) {
        if (key === "c") this.resolve({ response: "continue", message: "" });
        else if (key === "a") this.resolve({ response: "abort", message: "Operator aborted the run." });
        else if (key === "g") {
          this.inputMode = "guidance";
          this.inputText = "";
          this.footer = "Guidance: █";
          this.draw();
        }
        continue;
      }
      if (key === "p") {
        this.pauseRequested = true;
        this.footer = "Pause requested; waiting for the current node to finish safely…";
        this.draw();
      } else if (key === "t") {
        this.traceEnabled = !this.traceEnabled;
        this.changeTrace(this.traceEnabled);
        this.add(`Raw trace ${this.traceEnabled ? "enabled" : "disabled"}.`);
      }
    }
  };

  private resolve(value: PauseResponse): void {
    const resolve = this.response;
    this.response = undefined;
    this.waiting = false;
    this.inputMode = undefined;
    this.inputText = "";
    this.footer = "[p] pause after node  [t] raw trace  [Ctrl-C] cancel";
    resolve?.(value);
  }

  private resolveTask(task: string): void {
    const resolve = this.taskResponse;
    this.taskResponse = undefined;
    this.inputMode = undefined;
    this.inputText = "";
    this.footer = "Starting workflow…";
    resolve?.(task);
  }

  private add(line: string): void {
    this.lines.push(line.replace(/\s+/g, " ").trim());
    if (this.lines.length > 50) this.lines.splice(0, this.lines.length - 50);
  }

  private draw(): void {
    const view = renderTui({
      runId: this.runId,
      node: this.node,
      attempt: this.attempt,
      elapsedMs: performance.now() - this.startedAt,
      lines: this.lines,
      footer: this.footer,
    });
    process.stdout.write(`\u001b[2J\u001b[H${view}`);
  }
}
