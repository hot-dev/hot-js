import type { RunRecord, TaskRecord } from "../types.js";

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
}

export interface RunCancelEvent {
  type: "run:cancel";
  run?: RunRecord;
}

export interface RunUpdateEvent {
  type: "run:update";
  run: RunRecord;
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
  stream_id: string;
}

export interface TaskUpdateEvent {
  type: "task:update";
  task: TaskRecord;
}

export interface KeepaliveEvent {
  type: "keepalive";
}

/**
 * An event whose `type` this SDK version does not know, wrapped so that the
 * `StreamEvent` union narrows on `type`. `event_type` is the original type and
 * `data` the original payload.
 */
export interface UnknownStreamEvent {
  type: "unknown";
  event_type: string;
  data: Record<string, unknown>;
}

export type KnownStreamEvent =
  | EventPublishedEvent
  | StreamDataEvent
  | RunStartEvent
  | RunStopEvent
  | RunFailEvent
  | RunCancelEvent
  | RunUpdateEvent
  | StreamCompleteEvent
  | TaskUpdateEvent
  | KeepaliveEvent;

export type StreamEvent = KnownStreamEvent | UnknownStreamEvent;

const KNOWN_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set<KnownStreamEvent["type"]>([
  "event:published",
  "stream:data",
  "run:start",
  "run:stop",
  "run:fail",
  "run:cancel",
  "run:update",
  "stream:complete",
  "task:update",
  "keepalive",
]);

/**
 * Turn a parsed SSE payload into a `StreamEvent`. Known types pass through;
 * others are wrapped as `UnknownStreamEvent`. Returns undefined for payloads
 * without a string `type`.
 */
export function toStreamEvent(value: unknown): StreamEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  if (KNOWN_STREAM_EVENT_TYPES.has(type)) return value as KnownStreamEvent;
  return { type: "unknown", event_type: type, data: value as Record<string, unknown> };
}

export function runIdFromEvent(event: StreamEvent): string | undefined {
  switch (event.type) {
    case "run:start":
    case "run:stop":
    case "run:fail":
    case "run:cancel":
      return event.run?.run_id;
    case "run:update":
      return event.run.run_id;
    case "stream:data":
      return event.run_id;
    default:
      return undefined;
  }
}

/** Whether `value` is an event this SDK knows (an `UnknownStreamEvent` is not). */
export function isStreamEvent(value: unknown): value is KnownStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && KNOWN_STREAM_EVENT_TYPES.has(type);
}

/** Whether a `run:*` lifecycle event is terminal (stop, fail or cancel). */
export function isRunTerminalEvent(
  event: StreamEvent,
): event is RunStopEvent | RunFailEvent | RunCancelEvent {
  return event.type === "run:stop" || event.type === "run:fail" || event.type === "run:cancel";
}

export function eventIdFromRun(run: RunRecord | undefined): string | undefined {
  return run?.event_id ?? undefined;
}
