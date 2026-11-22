import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import { HotApiError } from "../src/errors.js";
import { mergeAbortSignals } from "../src/retry.js";
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
        seenUserAgents.push(new Headers(init?.headers).get("User-Agent") ?? undefined);
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

  it("bounds 429 retry sleeps by timeoutMs instead of sleeping past the deadline", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "t",
      timeoutMs: 150,
      fetch: async () => {
        calls += 1;
        return json429("30");
      },
    });
    const started = Date.now();
    const err = await hot.runs.get("run_1").catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toMatchObject({ name: "TimeoutError" });
    expect((err as Error).cause).toBeInstanceOf(HotApiError);
    expect(calls).toBe(1);
  });

  it("retries POST 503 event_publish_in_progress and does not retry 409 event_id_conflict", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({
            error: {
              code: "event_publish_in_progress",
              message: "Event publish already in progress",
              retry_after: 0,
            },
          }), { status: 503 });
        }
        return Response.json({ data: { event_id: "e-1" }, meta: {} });
      },
    });
    const event = await hot.events.publish({ event_id: "e-1", event_type: "x", event_data: {} });
    expect(event.event_id).toBe("e-1");
    expect(calls).toBe(2);

    // Fallback backoff when retry_after is omitted on 503 event_publish_in_progress
    let fallbackCalls = 0;
    const fallbackHot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => {
        fallbackCalls += 1;
        if (fallbackCalls === 1) {
          return new Response(JSON.stringify({
            error: { code: "event_publish_in_progress", message: "in progress" },
          }), { status: 503 });
        }
        return Response.json({ data: { event_id: "e-2" }, meta: {} });
      },
    });
    await expect(fallbackHot.events.publish({ event_id: "e-2", event_type: "x", event_data: {} }))
      .resolves.toMatchObject({ event_id: "e-2" });
    expect(fallbackCalls).toBe(2);

    // 409 event_id_conflict must NOT be retried
    let conflictCalls = 0;
    const conflictHot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => {
        conflictCalls += 1;
        return new Response(JSON.stringify({
          error: { code: "event_id_conflict", message: "event_id already used for a different payload" },
        }), { status: 409 });
      },
    });
    await expect(conflictHot.events.publish({ event_id: "e-1", event_type: "y", event_data: {} }))
      .rejects.toMatchObject({ status: 409, code: "event_id_conflict" });
    expect(conflictCalls).toBe(1);
  });

  it("uses redirect: manual and turns 3xx responses into HotApiError without retrying", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async (_input, init) => {
        calls += 1;
        expect(init?.redirect).toBe("manual");
        return new Response("", {
          status: 302,
          headers: { Location: "https://evil.example/redirect" },
        });
      },
    });

    const jsonErr = await hot.runs.get("run_1").catch((e: unknown) => e);
    expect(jsonErr).toBeInstanceOf(HotApiError);
    expect((jsonErr as HotApiError).status).toBe(302);
    expect((jsonErr as HotApiError).headers.get("Location")).toBe("https://evil.example/redirect");
    expect(calls).toBe(1);

    const rawErr = await hot.requestRaw("GET", "/files/f1/download").catch((e: unknown) => e);
    expect(rawErr).toBeInstanceOf(HotApiError);
    expect((rawErr as HotApiError).status).toBe(302);
    expect(calls).toBe(2);
  });

  it("wraps non-JSON 2xx SyntaxError with HTTP status and content-type context", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "t",
      fetch: async () => new Response("<html>gateway page</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    });

    const err = await hot.runs.get("run_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("status 200");
    expect((err as Error).message).toContain("text/html");
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it("clamps oversized timeoutMs to 32-bit timer max and disables timeout at 0", async () => {
    const huge = new HotClient({
      baseUrl: "http://hot.test",
      token: "t",
      timeoutMs: 3_000_000_000,
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return jsonOk();
      },
    });
    await expect(huge.runs.get("run_1")).resolves.toMatchObject({ run_id: "run_1" });

    const disabled = new HotClient({
      baseUrl: "http://hot.test",
      token: "t",
      timeoutMs: 0,
      fetch: async (_input, init) => {
        expect(init?.signal).toBeUndefined();
        return jsonOk();
      },
    });
    await expect(disabled.runs.get("run_1")).resolves.toMatchObject({ run_id: "run_1" });
  });

  it("mergeAbortSignals uses AbortSignal.any and fallback cleans up listeners", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals([a.signal, b.signal]);
    expect(merged.aborted).toBe(false);
    b.abort(new Error("boom"));
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toMatchObject({ message: "boom" });

    // Exercise fallback path when AbortSignal.any is unavailable
    const origAny = AbortSignal.any;
    try {
      (AbortSignal as unknown as { any: unknown }).any = undefined;
      let added = 0;
      let removed = 0;
      const longLived = new AbortController();
      const origAdd = longLived.signal.addEventListener.bind(longLived.signal);
      const origRemove = longLived.signal.removeEventListener.bind(longLived.signal);
      longLived.signal.addEventListener = (...args: Parameters<typeof origAdd>) => {
        added += 1;
        return origAdd(...args);
      };
      longLived.signal.removeEventListener = (...args: Parameters<typeof origRemove>) => {
        removed += 1;
        return origRemove(...args);
      };

      const shortLived = new AbortController();
      const fallbackMerged = mergeAbortSignals([longLived.signal, shortLived.signal]);
      shortLived.abort(new Error("done"));
      expect(fallbackMerged.aborted).toBe(true);
      expect(added).toBe(1);
      expect(removed).toBe(1);
    } finally {
      (AbortSignal as unknown as { any: typeof origAny }).any = origAny;
    }
  });
});
