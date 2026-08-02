import { describe, expect, it } from "vitest";
import { HotClient, HotTaskError } from "../src/index.js";

function taskEvent(status: string, result?: unknown): Response {
  const task = {
    task_id: "t1",
    env_id: "env1",
    stream_id: "s1",
    build_id: "b1",
    function_name: "work",
    task_type: "code",
    status,
    result,
    timeout_ms: 60_000,
    retry_attempt: 0,
    created_at: "2026-01-01T00:00:00Z",
  };
  return new Response(`data: ${JSON.stringify({ type: "task:update", task })}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("tasks", () => {
  it("returns an already-completed durable snapshot", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "token",
      fetch: async () => taskEvent("completed", { answer: 42 }),
    });

    await expect(hot.tasks.wait("t1")).resolves.toMatchObject({
      task_id: "t1",
      status: "completed",
      result: { answer: 42 },
    });
  });

  it("reconnects after a premature close", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "token",
      fetch: async () => {
        calls += 1;
        return calls === 1 ? taskEvent("running") : taskEvent("completed", "done");
      },
    });

    await expect(hot.tasks.wait("t1")).resolves.toMatchObject({ status: "completed" });
    expect(calls).toBe(2);
  });

  it("raises a structured error for terminal failures", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "token",
      fetch: async () => taskEvent("failed", { error: "boom" }),
    });

    await expect(hot.tasks.wait("t1")).rejects.toMatchObject({
      name: "HotTaskError",
      message: "boom",
      task: { task_id: "t1", status: "failed" },
    } satisfies Partial<HotTaskError>);
  });
});
