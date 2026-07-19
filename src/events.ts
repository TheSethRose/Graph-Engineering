export type WorkflowEvent = {
  time: string;
  event: string;
  [field: string]: unknown;
};

let eventSink: ((event: WorkflowEvent) => void) | undefined;

export function setEventSink(sink?: (event: WorkflowEvent) => void): void {
  eventSink = sink;
}

export function logEvent(event: string, fields: Record<string, unknown>): void {
  const entry = { time: new Date().toISOString(), event, ...fields };
  if (eventSink) eventSink(entry);
  else process.stderr.write(`${JSON.stringify(entry)}\n`);
}
