import type { HttpClient } from "../http.js";
import { STREAM_IDLE_TIMEOUT_MS, waitForSnapshot } from "../streaming/durable.js";
import { consumeSseResponse } from "../streaming/sse.js";
import type { TaskUpdateEvent } from "../streaming/types.js";
import { resultMessage } from "../streaming/wait.js";
import type { TaskRecord } from "../types.js";

const enc = encodeURIComponent;

export interface WaitForTaskOptions {
  timeoutMs?: number;
  /** Consecutive failed connections tolerated. Default 5. */
  maxReconnectAttempts?: number;
  signal?: AbortSignal;
}

export class HotTaskError extends Error {
  readonly task: TaskRecord;

  constructor(task: TaskRecord) {
    super(resultMessage(task.result) ?? `Task ${task.status}`);
    this.name = "HotTaskError";
    this.task = task;
  }
}

export class TasksResource {
  constructor(private readonly http: HttpClient) {}

  async get(taskId: string, options?: { signal?: AbortSignal }): Promise<TaskRecord> {
    const envelope = await this.http.requestJson<TaskRecord>("GET", `/tasks/${taskId}`, {
      signal: options?.signal,
    });
    return envelope.data;
  }

  subscribe(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<TaskUpdateEvent, void, undefined> {
    const events = this.subscribeOnce(taskId, options?.signal);

    return (async function* () {
      for await (const event of events) {
        if (event.type === "task:update") yield event;
      }
    })();
  }

  private subscribeOnce(taskId: string, signal?: AbortSignal, idleTimeoutMs?: number) {
    return consumeSseResponse(async () => {
      return this.http.requestRaw("GET", `/tasks/${enc(taskId)}/subscribe`, {
        headers: { Accept: "text/event-stream" },
        signal,
      });
    }, { signal, idleTimeoutMs });
  }

  /**
   * Wait for a task's terminal snapshot. Resolves with a `completed` task and
   * throws `HotTaskError` for `failed`, `cancelled` and `timed_out`.
   * Reconnects with backoff on transient errors; stops on permanent ones.
   */
  async wait(taskId: string, options?: WaitForTaskOptions): Promise<TaskRecord> {
    return waitForSnapshot<TaskRecord>({
      open: (signal) => this.subscribeOnce(taskId, signal, STREAM_IDLE_TIMEOUT_MS),
      snapshot: (event) => (event.type === "task:update" ? event.task : undefined),
      settle: (task) => {
        if (task.status === "completed") return { done: task };
        if (["failed", "cancelled", "timed_out"].includes(task.status)) {
          return { failed: new HotTaskError(task) };
        }
        return undefined;
      },
      timeoutMs: options?.timeoutMs ?? 60_000,
      maxReconnectAttempts: options?.maxReconnectAttempts,
      signal: options?.signal,
      timeoutMessage: "Timeout waiting for task",
      exhaustedMessage: "Task subscription ended before the task completed",
    });
  }
}
