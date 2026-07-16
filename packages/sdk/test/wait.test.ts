import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";

function sse(...events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${event}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("waitForRunResult", () => {
  it("uses nested run result details for failed runs", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const { pathname } = new URL(url);

        if (init?.method === "POST" && pathname === "/v1/events") {
          return new Response(JSON.stringify({
            data: {
              event_id: "e1",
              stream_id: "s1",
            },
            meta: {
              request_id: "req_123",
              timestamp: "2026-01-01T00:00:00Z",
            },
          }));
        }

        if (init?.method === "GET" && pathname === "/v1/streams/s1/subscribe") {
          return sse(
            'data: {"type":"run:start","run":{"run_id":"r1","event_id":"e1"}}',
            'data: {"type":"run:fail","run":{"run_id":"r1","event_id":"e1","status":"failed","result":{"$err":{"message":"boom"}}}}',
          );
        }

        throw new Error(`Unexpected request: ${init?.method} ${url}`);
      },
    });

    await expect(hot.events.callHot("demo/fn")).rejects.toThrow("boom");
  });

  it("surfaces the message from the hot 2.6 run Failure shape", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const { pathname } = new URL(url);

        if (init?.method === "POST" && pathname === "/v1/events") {
          return new Response(JSON.stringify({
            data: {
              event_id: "e1",
              stream_id: "s1",
            },
            meta: {
              request_id: "req_123",
              timestamp: "2026-01-01T00:00:00Z",
            },
          }));
        }

        if (init?.method === "GET" && pathname === "/v1/streams/s1/subscribe") {
          return sse(
            'data: {"type":"run:start","run":{"run_id":"r1","event_id":"e1"}}',
            'data: {"type":"run:fail","run":{"run_id":"r1","event_id":"e1","status":"failed","result":{"$type":"::hot::run/Failure","$origin":{"function":"::hot::exec/fail"},"$val":{"msg":"too hot","err":"too hot"}}}}',
          );
        }

        throw new Error(`Unexpected request: ${init?.method} ${url}`);
      },
    });

    await expect(hot.events.callHot("demo/fn")).rejects.toThrow("too hot");
  });
});
