import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import { VERSION } from "../src/version.js";

function json429(retryAfter?: string): Response {
  return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Slow down" } }), {
    status: 429,
    headers: retryAfter ? { "Retry-After": retryAfter } : {},
  });
}

function jsonOk(): Response {
  return new Response(JSON.stringify({ data: { run_id: "run_1" }, meta: {} }));
}

describe("429 retry", () => {
  it("retries a 429 with retry_after and sends the SDK user-agent", async () => {
    const seenUserAgents: (string | undefined)[] = [];
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async (_input, init) => {
        seenUserAgents.push((init?.headers as Record<string, string>)["User-Agent"]);
        calls += 1;
        return calls === 1 ? json429("1") : jsonOk();
      },
    });

    const run = await hot.runs.get("run_1");

    expect(run.run_id).toBe("run_1");
    expect(calls).toBe(2);
    expect(seenUserAgents[0]).toBe(`hot-sdk-js/${VERSION}`);
  }, 15_000);

  it("gives up after two retries", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => {
        calls += 1;
        return json429("1");
      },
    });

    await expect(hot.runs.get("run_1")).rejects.toThrow("Slow down");
    expect(calls).toBe(3);
  }, 15_000);

  it("does not retry a 429 without retry_after", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => {
        calls += 1;
        return json429();
      },
    });

    await expect(hot.runs.get("run_1")).rejects.toThrow("Slow down");
    expect(calls).toBe(1);
  });
});

describe("transient gateway errors and timeouts", () => {
  function status(code: number): Response {
    return new Response(JSON.stringify({ error: { code: "unavailable", message: `status ${code}` } }), { status: code });
  }

  it("retries idempotent JSON requests on 502, 503 and 504", async () => {
    const statuses = [502, 503];
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => {
        calls += 1;
        const next = statuses.shift();
        return next ? status(next) : jsonOk();
      },
    });
    await expect(hot.runs.get("run_1")).resolves.toMatchObject({ run_id: "run_1" });
    expect(calls).toBe(3);
  });

  it("does not retry a POST on 503", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => {
        calls += 1;
        return status(503);
      },
    });
    await expect(hot.events.publish({ event_type: "x", event_data: {} })).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });

  it("bounds JSON requests, including DELETEs, by timeoutMs", async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
    const hot = new HotClient({ baseUrl: "http://hot.test", token: "t", fetch: hang, timeoutMs: 100 });
    const started = Date.now();
    await expect(hot.projects.get("p")).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(hot.projects.delete("p")).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(hot.serviceKeys.revoke("k")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
