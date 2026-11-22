import type { EventPublishedEvent, StreamDataEvent, StreamEvent } from "../streaming/types.js";
import { runIdFromEvent } from "../streaming/types.js";
import { resultMessage } from "../streaming/wait.js";
import type { RunRecord } from "../types.js";

/** Agent reply stream prefix, e.g. `team-agent:reply:delta`. */
export function replyLabel(agentName: string): string {
  return `${agentName}:reply:`;
}

export function replyDataType(agentName: string, verb: "start" | "delta" | "end" | "error" | "sources"): string {
  return `${agentName}:reply:${verb}`;
}

export interface FoldAgentReplyOptions {
  /** Agent namespace, e.g. `team-agent`. */
  label: string;
  /** Optional run-id filter (set after run:start). */
  runId?: string | null;
  signal?: AbortSignal;
}

export type AgentReplyChunk =
  | { type: "published"; streamId?: string; eventId?: string; eventType?: string }
  | { type: "start"; runId?: string; payload?: Record<string, unknown> }
  | { type: "delta"; text: string; runId?: string }
  | { type: "sources"; payload: Record<string, unknown>; runId?: string }
  | { type: "end"; text?: string; runId?: string }
  | { type: "error"; message: string; runId?: string }
  | { type: "run:stop"; run?: Record<string, unknown> }
  | { type: "run:fail"; error?: string }
  | { type: "run:cancel"; reason?: string };

export interface AgentReplyResult {
  text: string;
  status: "ok" | "error";
  error?: string;
  streamId?: string;
  eventId?: string;
  runId?: string;
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function payloadText(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function runRecordMessage(run: RunRecord | undefined, fallback: string): string {
  const message = resultMessage(run?.result);
  const status = typeof run?.status === "string" ? run.status : undefined;
  return message ?? (status ? `${fallback} (${status})` : fallback);
}

/**
 * Transform a Hot run-stream into agent reply chunks, filtering on
 * `{label}:reply:*` stream:data events.
 */
export async function* foldAgentReply(
  events: AsyncIterable<StreamEvent>,
  options: FoldAgentReplyOptions,
): AsyncGenerator<AgentReplyChunk, AgentReplyResult, undefined> {
  const prefix = replyLabel(options.label);
  let acc = "";
  let lastFinal: string | undefined;
  let failed: string | undefined;
  let runId = options.runId ?? null;
  let streamId: string | undefined;
  let eventId: string | undefined;
  let sawReplyEnd = false;
  const retriedFrom = new Set<string>();
  const adoptedRetryIds = new Set<string>();

  const matchesOrAdopts = (evtRunId: string | undefined, run: RunRecord | undefined): boolean => {
    if (!runId || !evtRunId || evtRunId === runId) return true;
    if (adoptedRetryIds.has(evtRunId)) {
      runId = evtRunId;
      return true;
    }
    if (
      run?.origin_run_id
      && (run.origin_run_id === runId || retriedFrom.has(run.origin_run_id))
      && run.run_type !== "task"
    ) {
      runId = evtRunId;
      return true;
    }
    return false;
  };

  for await (const evt of events) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Aborted");
    }

    if (evt.type === "event:published") {
      const published = evt as EventPublishedEvent;
      streamId = published.stream_id;
      eventId = published.event_id;
      yield {
        type: "published",
        streamId,
        eventId,
        eventType: published.event_type,
      };
      continue;
    }

    if (evt.type === "run:start") {
      const candidate = runIdFromEvent(evt);
      if (candidate && !runId) {
        runId = candidate;
      } else if (!matchesOrAdopts(candidate, evt.run)) {
        continue;
      }
      yield { type: "start", runId: candidate, payload: evt.run as unknown as Record<string, unknown> | undefined };
      continue;
    }

    if (evt.type === "stream:data" && typeof evt.data_type === "string" && evt.data_type.startsWith(prefix)) {
      const data = evt as StreamDataEvent;
      const evtRunId = data.run_id;
      if (runId && evtRunId && evtRunId !== runId) {
        if (adoptedRetryIds.has(evtRunId)) {
          runId = evtRunId;
        } else {
          continue;
        }
      }

      const verb = data.data_type.slice(prefix.length);
      const payload = asPlainObject(data.payload);

      if (verb === "start") {
        yield { type: "start", runId: evtRunId, payload };
      } else if (verb === "delta") {
        const delta = payloadText(payload, ["delta", "text"]);
        if (delta) {
          acc += delta;
          yield { type: "delta", text: delta, runId: evtRunId };
        }
      } else if (verb === "sources") {
        yield { type: "sources", payload, runId: evtRunId };
      } else if (verb === "end") {
        lastFinal = payloadText(payload, ["text"]);
        sawReplyEnd = true;
        yield { type: "end", text: lastFinal, runId: evtRunId };
      } else if (verb === "error") {
        failed = payloadText(payload, ["message", "error"]) ?? "Agent reported an error.";
        yield { type: "error", message: failed, runId: evtRunId };
        return {
          text: failed,
          status: "error",
          error: failed,
          streamId,
          eventId,
          runId: runId ?? undefined,
        };
      }
      continue;
    }

    if (evt.type === "run:stop") {
      const stopRunId = runIdFromEvent(evt);
      if (!matchesOrAdopts(stopRunId, evt.run)) continue;
      if (evt.run?.status === "pending_retry") {
        if (stopRunId) retriedFrom.add(stopRunId);
        continue;
      }
      yield { type: "run:stop", run: evt.run as unknown as Record<string, unknown> | undefined };
      if (sawReplyEnd) break;
      continue;
    }

    if (evt.type === "run:fail") {
      const failRunId = runIdFromEvent(evt);
      if (!matchesOrAdopts(failRunId, evt.run)) continue;
      if (evt.run?.status === "pending_retry") {
        if (failRunId) retriedFrom.add(failRunId);
        if (evt.retry_run_id) {
          adoptedRetryIds.add(evt.retry_run_id);
          runId = evt.retry_run_id;
        }
        continue;
      }
      failed = runRecordMessage(evt.run, "Agent run failed.");
      yield { type: "run:fail", error: failed };
      return {
        text: failed,
        status: "error",
        error: failed,
        streamId,
        eventId,
        runId: runId ?? undefined,
      };
    }

    if (evt.type === "run:cancel") {
      const cancelRunId = runIdFromEvent(evt);
      if (!matchesOrAdopts(cancelRunId, evt.run)) continue;
      failed = runRecordMessage(evt.run, "Agent run was cancelled.");
      yield { type: "run:cancel", reason: failed };
      return {
        text: failed,
        status: "error",
        error: failed,
        streamId,
        eventId,
        runId: runId ?? undefined,
      };
    }

    // Do not break on `stream:complete` (5-minute rollover when reconnecting)
    // or `keepalive` / unrelated events after `sawReplyEnd` before `run:stop`.
  }

  const text = lastFinal ?? acc;
  return {
    text: text || "(no response text)",
    status: "ok",
    streamId,
    eventId,
    runId: runId ?? undefined,
  };
}
