import type { HttpClient } from "../http.js";
import { consumeSseResponse } from "../streaming/sse.js";
import type { TaskUpdateEvent } from "../streaming/types.js";
import { mergeAbortSignals, resultMessage } from "../streaming/wait.js";
import type { TaskRecord } from "../types.js";

export interface WaitForTaskOptions {
  timeoutMs?: number;
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
    const events = consumeSseResponse(async () => {
      return this.http.requestRaw("GET", `/tasks/${taskId}/subscribe`, {
        headers: { Accept: "text/event-stream" },
        signal: options?.signal,
      });
    }, { signal: options?.signal });

    return (async function* () {
      for await (const event of events) {
        if (event.type === "task:update") yield event as TaskUpdateEvent;
      }
    })();
  }

  async wait(taskId: string, options?: WaitForTaskOptions): Promise<TaskRecord> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Timeout waiting for task")),
      options?.timeoutMs ?? 60_000,
    );
    const signal = mergeAbortSignals([options?.signal, controller.signal]);
    let reconnectAttempts = 0;

    try {
      while (true) {
        try {
          for await (const event of this.subscribe(taskId, { signal })) {
            const task = event.task;
            if (task.status === "completed") return task;
            if (["failed", "cancelled", "timed_out"].includes(task.status)) {
              throw new HotTaskError(task);
            }
          }
        } catch (error) {
          if (error instanceof HotTaskError || signal.aborted) throw error;
          if (reconnectAttempts >= (options?.maxReconnectAttempts ?? 5)) throw error;
        }
        if (reconnectAttempts >= (options?.maxReconnectAttempts ?? 5)) {
          throw new Error("Task subscription ended before the task completed");
        }
        reconnectAttempts += 1;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
