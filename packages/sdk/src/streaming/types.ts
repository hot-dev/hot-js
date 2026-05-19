import type { RunRecord } from "../types.js";

export interface EventPublishedEvent {
  type: "event:published";
  event_id?: string;
  stream_id?: string;
  event_type?: string;
}

export interface RunStartEvent {
  type: "run:start";
  run?: RunRecord;
}

export interface RunStopEvent {
  type: "run:stop";
  run?: RunRecord;
}

export interface RunFailEvent {
  type: "run:fail";
  run?: RunRecord;
  error?: string;
}

export interface RunCancelEvent {
  type: "run:cancel";
  run?: RunRecord;
  reason?: string;
}

export interface StreamDataEvent {
  type: "stream:data";
  run_id?: string;
  stream_data_id?: string;
  data_type: string;
  payload?: Record<string, unknown>;
}

export interface StreamCompleteEvent {
  type: "stream:complete";
}

export interface UnknownStreamEvent {
  type: Exclude<
    string,
    | "event:published"
    | "stream:data"
    | "run:start"
    | "run:stop"
    | "run:fail"
    | "run:cancel"
    | "stream:complete"
  >;
  [key: string]: unknown;
}

export type StreamEvent =
  | EventPublishedEvent
  | StreamDataEvent
  | RunStartEvent
  | RunStopEvent
  | RunFailEvent
  | RunCancelEvent
  | StreamCompleteEvent
  | UnknownStreamEvent;

export function runIdFromEvent(event: StreamEvent): string | undefined {
  switch (event.type) {
    case "run:start":
    case "run:stop":
    case "run:fail":
    case "run:cancel": {
      const runEvent = event as RunStartEvent | RunStopEvent | RunFailEvent | RunCancelEvent;
      return runEvent.run?.run_id;
    }
    case "stream:data": {
      const data = event as StreamDataEvent;
      return data.run_id;
    }
    default:
      return undefined;
  }
}

export function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const type = (value as { type: unknown }).type;
  return typeof type === "string";
}

export function eventIdFromRun(run: RunRecord | undefined): string | undefined {
  return run?.event_id ?? undefined;
}
