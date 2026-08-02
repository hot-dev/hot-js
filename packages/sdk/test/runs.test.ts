import { describe, expect, it } from "vitest";
import { HotClient, HotRunError } from "../src/index.js";

function runEvent(status: string, result?: unknown): Response {
  const run = {
    run_id: "r1",
    env_id: "env1",
    stream_id: "s1",
    build_id: "b1",
    run_type: "event",
    status,
    start_time: "2026-01-01T00:00:00Z",
    stop_time: status === "running" ? null : "2026-01-01T00:00:01Z",
    origin_run_id: null,
    event_id: "e1",
    result,
    project_id: "p1",
    project_name: "fixture",
    retry_attempt: 0,
  };
  return new Response(`data: ${JSON.stringify({ type: "run:update", run })}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("runs", () => {
  it("returns an already-succeeded durable snapshot", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "token",
      fetch: async () => runEvent("succeeded", { answer: 42 }),
    });

    await expect(hot.runs.wait("r1")).resolves.toMatchObject({
      run_id: "r1",
      status: "succeeded",
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
        return calls === 1 ? runEvent("running") : runEvent("succeeded", "done");
      },
    });

    await expect(hot.runs.wait("r1")).resolves.toMatchObject({ status: "succeeded" });
    expect(calls).toBe(2);
  });

  it("raises a structured error for terminal failures", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "token",
      fetch: async () => runEvent("failed", { error: "boom" }),
    });

    await expect(hot.runs.wait("r1")).rejects.toMatchObject({
      name: "HotRunError",
      message: "boom",
      run: { run_id: "r1", status: "failed" },
    } satisfies Partial<HotRunError>);
  });
});
