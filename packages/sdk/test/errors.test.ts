import { describe, expect, it } from "vitest";
import { HotApiError, isHotApiError, parseApiError } from "../src/errors.js";

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
});
