import { describe, expect, it } from "vitest";
import { foldAgentReply, type AgentReplyChunk } from "../src/agent/reply.js";
import type { StreamEvent } from "../src/streaming/types.js";

async function* fakeStream(events: StreamEvent[]) {
  for (const evt of events) yield evt;
}

async function runFold(events: StreamEvent[], runId?: string | null) {
  const chunks: AgentReplyChunk[] = [];
  const gen = foldAgentReply(fakeStream(events), { label: "team-agent", runId });
  while (true) {
    const next = await gen.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

describe("foldAgentReply", () => {
  it("folds delta and end into final text", async () => {
    const { chunks, result } = await runFold([
      { type: "event:published", stream_id: "s1", event_id: "e1" },
      { type: "run:start", run: { run_id: "r1", event_id: "e1" } as never },
      {
        type: "stream:data",
        run_id: "r1",
        data_type: "team-agent:reply:delta",
        payload: { delta: "Hello" },
      },
      {
        type: "stream:data",
        run_id: "r1",
        data_type: "team-agent:reply:delta",
        payload: { delta: " world" },
      },
      {
        type: "stream:data",
        run_id: "r1",
        data_type: "team-agent:reply:end",
        payload: { text: "Hello world!" },
      },
    ]);

    expect(chunks.filter((c) => c.type === "delta").map((c) => c.text)).toEqual(["Hello", " world"]);
    expect(result.text).toBe("Hello world!");
    expect(result.status).toBe("ok");
  });

  it("ignores unrelated runs' run:fail and run:cancel", async () => {
    const { result } = await runFold([
      { type: "event:published", stream_id: "s1", event_id: "e1" },
      { type: "run:start", run: { run_id: "r1", event_id: "e1" } as never },
      { type: "run:fail", run: { run_id: "r_other", status: "failed", result: "unrelated fail" } as never },
      { type: "run:cancel", run: { run_id: "r_other2", status: "cancelled", result: "unrelated cancel" } as never },
      { type: "stream:data", run_id: "r1", data_type: "team-agent:reply:delta", payload: { delta: "ok" } },
      { type: "run:stop", run: { run_id: "r1", status: "succeeded" } as never },
    ]);

    expect(result.status).toBe("ok");
    expect(result.text).toBe("ok");
  });

  it("ignores pending_retry failures and follows the retry run", async () => {
    const { chunks, result } = await runFold([
      { type: "event:published", stream_id: "s1", event_id: "e1" },
      { type: "run:start", run: { run_id: "r1", event_id: "e1", run_type: "event" } as never },
      {
        type: "run:fail",
        run: { run_id: "r1", event_id: "e1", run_type: "event", status: "pending_retry", result: "transient" } as never,
        retry_run_id: "r2",
      },
      { type: "stream:data", run_id: "r2", data_type: "team-agent:reply:delta", payload: { delta: "recovered" } },
      { type: "stream:data", run_id: "r2", data_type: "team-agent:reply:end", payload: { text: "recovered!" } },
      { type: "run:stop", run: { run_id: "r2", origin_run_id: "r1", run_type: "event", status: "succeeded" } as never },
    ]);

    expect(chunks.some((c) => c.type === "run:fail")).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("recovered!");
    expect(result.runId).toBe("r2");
  });

  it("survives stream:complete rollovers and keepalive after reply:end before run:stop", async () => {
    const { chunks, result } = await runFold([
      { type: "event:published", stream_id: "s1", event_id: "e1" },
      { type: "run:start", run: { run_id: "r1", event_id: "e1" } as never },
      { type: "stream:data", run_id: "r1", data_type: "team-agent:reply:delta", payload: { delta: "part1-" } },
      { type: "stream:complete", stream_id: "s1" },
      { type: "stream:data", run_id: "r1", data_type: "team-agent:reply:delta", payload: { delta: "part2" } },
      { type: "stream:data", run_id: "r1", data_type: "team-agent:reply:end", payload: { text: "part1-part2" } },
      { type: "keepalive" },
      { type: "run:stop", run: { run_id: "r1", status: "succeeded" } as never },
    ]);

    expect(chunks.map((c) => c.type)).toEqual(["published", "start", "delta", "delta", "end", "run:stop"]);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("part1-part2");
  });

  it("safely handles non-object stream:data payloads", async () => {
    const { result } = await runFold([
      { type: "run:start", run: { run_id: "r1" } as never },
      { type: "stream:data", run_id: "r1", data_type: "team-agent:reply:delta", payload: "raw-string" },
      { type: "stream:data", run_id: "r1", data_type: "team-agent:reply:delta", payload: null },
      { type: "stream:data", run_id: "r1", data_type: "team-agent:reply:delta", payload: { delta: "safe" } },
      { type: "run:stop", run: { run_id: "r1", status: "succeeded" } as never },
    ]);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("safe");
  });
});
