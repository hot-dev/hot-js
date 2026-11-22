import { describe, expect, it } from "vitest";
import { HotApiError, HotKeyScopeError, isHotApiError, parseApiError } from "../src/errors.js";

describe("HotApiError", () => {
  it("preserves structured API error fields and headers", async () => {
    const headers = new Headers({ "Retry-After": "10" });
    const error = parseApiError(429, JSON.stringify({
      error: {
        code: "rate_limit_exceeded",
        message: "slow down",
        request_id: "req_123",
        retry_after: 10,
      },
    }), headers);

    expect(error).toBeInstanceOf(HotApiError);
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limit_exceeded");
    expect(error.requestId).toBe("req_123");
    expect(error.retryAfter).toBe(10);
    expect(error.headers.get("Retry-After")).toBe("10");
    expect(isHotApiError(error)).toBe(true);
  });

  it("recognizes HotKeyScopeError in both same-realm and cross-realm checks", () => {
    const real = new HotKeyScopeError(403, "", "org");
    expect(isHotApiError(real)).toBe(true);

    const crossRealmApi = { name: "HotApiError", status: 500, message: "err" };
    const crossRealmScope = { name: "HotKeyScopeError", status: 403, requiredScope: "org", message: "err" };
    const nonApi = { name: "Error", status: 500 };

    expect(isHotApiError(crossRealmApi)).toBe(true);
    expect(isHotApiError(crossRealmScope)).toBe(true);
    expect(isHotApiError(nonApi)).toBe(false);
  });

  it("parses numeric and HTTP-date Retry-After headers and rejects negative or blank values", () => {
    const blank = parseApiError(429, "slow", new Headers({ "Retry-After": "   " }));
    expect(blank.retryAfter).toBeUndefined();

    const negative = parseApiError(429, "slow", new Headers({ "Retry-After": "-5" }));
    expect(negative.retryAfter).toBeUndefined();

    const negZero = parseApiError(429, "slow", new Headers({ "Retry-After": "-0" }));
    expect(negZero.retryAfter).toBeUndefined();

    const invalid = parseApiError(429, "slow", new Headers({ "Retry-After": "not-a-date" }));
    expect(invalid.retryAfter).toBeUndefined();

    const zero = parseApiError(429, "slow", new Headers({ "Retry-After": "0" }));
    expect(zero.retryAfter).toBe(0);

    const futureDate = new Date(Date.now() + 5_000).toUTCString();
    const fromFuture = parseApiError(429, "slow", new Headers({ "Retry-After": futureDate }));
    expect(fromFuture.retryAfter).toBeGreaterThan(2);
    expect(fromFuture.retryAfter).toBeLessThanOrEqual(6);

    const pastDate = "Wed, 21 Oct 2015 07:28:00 GMT";
    const fromPast = parseApiError(429, "slow", new Headers({ "Retry-After": pastDate }));
    expect(fromPast.retryAfter).toBe(0);

    // Negative JSON retry_after is ignored and falls back to a valid header.
    const badJson = parseApiError(
      429,
      JSON.stringify({ error: { code: "rate_limited", message: "slow", retry_after: -10 } }),
      new Headers({ "Retry-After": "7" }),
    );
    expect(badJson.retryAfter).toBe(7);
  });
});
