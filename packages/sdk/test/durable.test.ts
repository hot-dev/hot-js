// Reconnect policy, rollover budgets, chunk ordering and pending_retry
// handling shared by subscribeWithEvent, callHot, waitForRunResult,
// runs.wait and tasks.wait.
import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import { HotApiError } from "../src/errors.js";
import { waitForRunResult } from "../src/streaming/wait.js";
import type { StreamEvent } from "../src/streaming/types.js";

type Step =
  | { sse: string[]; keepOpen?: boolean }
  | { status: number; headers?: Record<string, string>; code?: string }
  | { network: true };

interface Call {
  method: string;
  path: string;
  at: number;
}

function scripted(steps: Step[]) {
  const calls: Call[] = [];
  const start = Date.now();
  const hot = new HotClient({
    baseUrl: "http://hot.test",
    token: "token",
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ method: init?.method ?? "GET", path: new URL(url).pathname, at: Date.now() - start });
      const step = steps.shift();
      if (!step) throw new Error(`Unexpected request: ${init?.method} ${url}`);
      if ("network" in step) throw new TypeError("fetch failed");
      if ("status" in step) {
        return new Response(JSON.stringify({ error: { code: step.code ?? "error", message: `status ${step.status}` } }), {
          status: step.status,
          headers: step.headers,
        });
      }
      const encoder = new TextEncoder();
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const block of step.sse) controller.enqueue(encoder.encode(`data: ${block}\n\n`));
          // keepOpen: an idle live connection, closed only by the client.
          if (!step.keepOpen) controller.close();
          else signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { hot, calls, steps };
}

const published = '{"type":"event:published","stream_id":"s1","event_id":"e1"}';
const rollover = '{"type":"stream:complete","stream_id":"s1"}';
const start = (run: string, event = "e1") => `{"type":"run:start","run":{"run_id":"${run}","event_id":"${event}"}}`;
const stop = (run: string, result: unknown, event = "e1") =>
  `{"type":"run:stop","run":{"run_id":"${run}","event_id":"${event}","status":"succeeded","result":${JSON.stringify(result)}}}`;
const chunk = (run: string, text: string) =>
  `{"type":"stream:data","run_id":"${run}","data_type":"ai:delta","payload":{"text":"${text}"}}`;
const runUpdate = (status: string) =>
  `{"type":"run:update","run":{"run_id":"r1","status":"${status}","result":"done"}}`;
const taskUpdate = (status: string) =>
  `{"type":"task:update","task":{"task_id":"t1","status":"${status}","result":"done"}}`;

async function collect(iter: AsyncGenerator<StreamEvent, void, undefined>) {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("reconnect policy", () => {
  for (const status of [401, 403, 404]) {
    it(`stops subscribeWithEvent on a permanent ${status} without retrying`, async () => {
      const { hot, calls } = scripted([{ sse: [published, start("r1")] }, { status }]);
      await expect(collect(hot.streams.subscribeWithEvent({ event_type: "x", event_data: {} })))
        .rejects.toMatchObject({ status });
      expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    });

    it(`stops runs.wait on a permanent ${status} after one request`, async () => {
      const { hot, calls } = scripted([{ status }]);
      await expect(hot.runs.wait("r1")).rejects.toMatchObject({ status });
      expect(calls).toHaveLength(1);
    });
  }

  it("retries 503 and connection failures with growing backoff", async () => {
    const { hot, calls } = scripted([
      { sse: [published, start("r1")] },
      { status: 503 },
      { network: true },
      { sse: [stop("r1", "ok")] },
    ]);
    const events = await collect(hot.streams.subscribeWithEvent({ event_type: "x", event_data: {} }));
    expect(events.at(-1)?.type).toBe("run:stop");
    expect(calls).toHaveLength(4);
    // First failure waits 250-500 ms, the second 500-1000 ms.
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(240);
    expect(calls[3]!.at - calls[2]!.at).toBeGreaterThanOrEqual(490);
  });

  it("honours Retry-After on 429", async () => {
    const { hot, calls } = scripted([
      { status: 429, headers: { "Retry-After": "1" } },
      { sse: [taskUpdate("completed")] },
    ]);
    await expect(hot.tasks.wait("t1")).resolves.toMatchObject({ status: "completed" });
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(990);
  });

  it("re-sends subscribe-with-event only when it was rejected before publishing", async () => {
    const { hot, calls } = scripted([
      { status: 429, headers: { "Retry-After": "0" } },
      { sse: [published, stop("r1", "ok")] },
    ]);
    await expect(hot.events.callHot("::app/fn")).resolves.toBe("ok");
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);

    const lost = scripted([{ network: true }]);
    await expect(lost.hot.events.callHot("::app/fn")).rejects.toThrow("fetch failed");
    expect(lost.calls).toHaveLength(1);
  });

  it("fails with a timeout, not a long sleep, when backoff would pass the deadline", async () => {
    const { hot, calls } = scripted([{ status: 503, headers: { "Retry-After": "30" } }]);
    const started = Date.now();
    const error = await hot.runs.wait("r1", { timeoutMs: 2_000 }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error).toMatchObject({ name: "TimeoutError", message: "Timeout waiting for run" });
    expect((error as Error).cause).toBeInstanceOf(HotApiError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxAttempts consecutive connections that made no progress", async () => {
    const { hot, calls } = scripted([
      { sse: [runUpdate("running")] },
      { sse: [runUpdate("running")] },
      { sse: [runUpdate("running")] },
      { sse: [runUpdate("running")] },
    ]);
    await expect(hot.runs.wait("r1", { maxReconnectAttempts: 2 }))
      .rejects.toThrow("Run subscription ended before the run completed");
    // One connection with progress, then three replays of the same snapshot.
    expect(calls).toHaveLength(4);
  });

  it("treats a pending_retry run as failed in runs.wait", async () => {
    const { hot } = scripted([{ sse: [runUpdate("pending_retry")] }]);
    await expect(hot.runs.wait("r1")).rejects.toMatchObject({ name: "HotRunError", run: { status: "pending_retry" } });
  });
});

describe("rollovers", () => {
  it("survives more 5-minute rollovers than maxAttempts", async () => {
    const steps: Step[] = [{ sse: [published, start("r1"), rollover] }];
    for (let i = 0; i < 7; i++) steps.push({ sse: [start("r1"), rollover] });
    steps.push({ sse: [start("r1"), stop("r1", { answer: 42 })] });
    const { hot, calls } = scripted(steps);

    const events = await collect(hot.streams.subscribeWithEvent(
      { event_type: "x", event_data: {} },
      { reconnect: { maxAttempts: 2 } },
    ));
    expect(events.filter((event) => event.type === "stream:complete")).toHaveLength(8);
    expect(events.at(-1)).toMatchObject({ type: "run:stop", run: { result: { answer: 42 } } });
    expect(calls).toHaveLength(9);
    // Rollovers reconnect at once.
    expect(calls.at(-1)!.at).toBeLessThan(500);
  });

  it("lets callHot outlast rollovers too", async () => {
    const steps: Step[] = [{ sse: [published, start("r1"), rollover] }];
    for (let i = 0; i < 6; i++) steps.push({ sse: [rollover] });
    steps.push({ sse: [stop("r1", 5)] });
    const { hot } = scripted(steps);
    await expect(hot.events.callHot("::app/add", [2, 3], { maxReconnectAttempts: 1 })).resolves.toBe(5);
  });
});

describe("stream:data ordering", () => {
  it("delivers chunks that arrive before run:start", async () => {
    const { hot } = scripted([{
      sse: [published, chunk("r1", "a"), chunk("r1", "b"), start("r1"), chunk("r1", "c"), stop("r1", "done")],
    }]);
    const chunks: string[] = [];
    await expect(hot.events.callHot("::app/stream", [], { onChunk: (text) => chunks.push(text) }))
      .resolves.toBe("done");
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("delivers chunks when run:stop precedes run:start (today's server order)", async () => {
    const { hot } = scripted([{
      sse: [published, chunk("r1", "a"), chunk("r1", "b"), chunk("r1", "c"), stop("r1", "done"), start("r1")],
    }]);
    const chunks: string[] = [];
    await expect(hot.events.callHot("::app/stream", [], { onChunk: (text) => chunks.push(text) }))
      .resolves.toBe("done");
    expect(chunks).toEqual(["a", "b", "c"]);
  });

  it("keeps other runs' chunks out", async () => {
    const { hot } = scripted([{
      sse: [published, chunk("other", "x"), chunk("r1", "a"), start("other", "e0"), stop("other", 1, "e0"), stop("r1", 2)],
    }]);
    const chunks: string[] = [];
    await expect(hot.events.callHot("::app/stream", [], { onChunk: (text) => chunks.push(text) })).resolves.toBe(2);
    expect(chunks).toEqual(["a"]);
  });

  it("orders waitForRunResult chunks the same way", async () => {
    const { hot } = scripted([{ sse: [chunk("r1", "a"), stop("r1", "done"), start("r1")] }]);
    const chunks: string[] = [];
    const run = await waitForRunResult(hot.http, "s1", "e1", { onChunk: (text) => chunks.push(text) });
    expect(run.result).toBe("done");
    expect(chunks).toEqual(["a"]);
  });
});

describe("pending_retry", () => {
  const fail = '{"type":"run:fail","run":{"run_id":"rA","event_id":"e1","run_type":"event","status":"pending_retry","retry_attempt":1,"result":"first attempt"}}';
  const retryStop = '{"type":"run:stop","run":{"run_id":"rB","event_id":"e9","origin_run_id":"rA","run_type":"event","status":"succeeded","retry_attempt":1,"result":{"recovered":true}}}';

  it("follows a retrying handler to its retry run in callHot", async () => {
    const { hot } = scripted([{ sse: [published, fail, chunk("rB", "late"), retryStop] }]);
    const chunks: string[] = [];
    await expect(hot.events.callHot("::app/flaky", [], { onChunk: (text) => chunks.push(text) }))
      .resolves.toEqual({ recovered: true });
    expect(chunks).toEqual(["late"]);
  });

  it("keeps subscribeWithEvent open past pending_retry", async () => {
    const { hot } = scripted([{ sse: [published, fail] }, { sse: [retryStop] }]);
    const events = await collect(hot.streams.subscribeWithEvent({ event_type: "x", event_data: {} }));
    expect(events.map((event) => event.type)).toEqual(["event:published", "run:fail", "run:stop"]);
  });

  it("does not adopt unrelated runs that name the run as origin", async () => {
    const task = '{"type":"run:stop","run":{"run_id":"rT","event_id":"e5","origin_run_id":"r1","run_type":"task","status":"succeeded","retry_attempt":0,"result":"task"}}';
    const { hot } = scripted([{ sse: [published, start("r1"), task, stop("r1", "handler")] }]);
    await expect(hot.events.callHot("::app/fn")).resolves.toBe("handler");
  });

  it("reports the final failure when the retries are exhausted", async () => {
    const finalFail = '{"type":"run:fail","run":{"run_id":"rB","event_id":"e9","origin_run_id":"rA","run_type":"event","status":"failed","retry_attempt":1,"result":"second attempt"}}';
    const { hot } = scripted([{ sse: [published, fail, finalFail] }]);
    await expect(hot.events.callHot("::app/flaky")).rejects.toThrow("second attempt");
  });
});

// The server replays a retried first attempt lossily (see the SDK notes):
// before the retry is queued as run:fail or run:stop with status
// pending_retry; after, as run:fail with status failed and retry_attempt 1,
// possibly before the retry run exists, and newest runs first.
describe("lossy replays of a retried attempt", () => {
  const run = (fields: Record<string, unknown>) => JSON.stringify({ run_type: "event", ...fields });
  const firstAttempt = (type: string, status: string) =>
    `{"type":"${type}","run":${run({ run_id: "rA", event_id: "e1", status, retry_attempt: 1, result: "first attempt" })}}`;
  const retryStart = `{"type":"run:start","run":${run({ run_id: "rB", event_id: "e9", origin_run_id: "rA", status: "running", retry_attempt: 1 })}}`;
  const retryStop = `{"type":"run:stop","run":${run({ run_id: "rB", event_id: "e9", origin_run_id: "rA", status: "succeeded", retry_attempt: 1, result: { recovered: true } })}}`;

  it("does not take run:stop with status pending_retry as success", async () => {
    const { hot } = scripted([{ sse: [published, firstAttempt("run:stop", "pending_retry"), retryStart, retryStop] }]);
    await expect(hot.events.callHot("::app/flaky")).resolves.toEqual({ recovered: true });
  });

  it("holds run:fail with status failed and a scheduled retry until the retry run appears", async () => {
    // The retry run shows up only on the next connection.
    const { hot, calls } = scripted([
      { sse: [published, firstAttempt("run:fail", "failed")] },
      { sse: [retryStart, retryStop] },
    ]);
    await expect(hot.events.callHot("::app/flaky")).resolves.toEqual({ recovered: true });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it("follows a retry that arrives before its origin run (newest first)", async () => {
    const { hot } = scripted([{ sse: [published, retryStop, firstAttempt("run:fail", "failed"), retryStart] }]);
    const started = Date.now();
    await expect(hot.events.callHot("::app/flaky")).resolves.toEqual({ recovered: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("clears the hold as soon as the retry run appears", async () => {
    const { hot } = scripted([{ sse: [published, firstAttempt("run:fail", "failed"), retryStart, retryStop] }]);
    const started = Date.now();
    await expect(hot.events.callHot("::app/flaky")).resolves.toEqual({ recovered: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a held failure at the caller's deadline instead of a timeout", async () => {
    const { hot } = scripted([{ sse: [published, firstAttempt("run:fail", "failed")], keepOpen: true }]);
    const started = Date.now();
    const error = await hot.events.callHot("::app/flaky", [], { timeoutMs: 800 }).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error).toMatchObject({ message: "first attempt" });
    expect((error as Error).name).not.toBe("TimeoutError");
  });

  it("ends subscribeWithEvent after the grace when no retry appears", async () => {
    const { hot } = scripted([{ sse: [published, firstAttempt("run:fail", "failed")], keepOpen: true }]);
    const started = Date.now();
    const events = await collect(hot.streams.subscribeWithEvent({ event_type: "x", event_data: {} }));
    const elapsed = Date.now() - started;
    expect(events.map((event) => event.type)).toEqual(["event:published", "run:fail"]);
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(7_000);
  }, 10_000);

  it("fails a first attempt without a scheduled retry at once", async () => {
    const plain = `{"type":"run:fail","run":${run({ run_id: "rA", event_id: "e1", status: "failed", retry_attempt: 0, result: "boom" })}}`;
    const task = `{"type":"run:stop","run":${run({ run_id: "rT", event_id: "e5", origin_run_id: "rA", run_type: "task", status: "succeeded", result: "task" })}}`;
    const { hot } = scripted([{ sse: [published, task, plain] }]);
    const started = Date.now();
    await expect(hot.events.callHot("::app/fn")).rejects.toThrow("boom");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
