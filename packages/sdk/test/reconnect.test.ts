import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import type { StreamEvent } from "../src/streaming/types.js";

interface Recorded {
  method: string;
  pathname: string;
}

interface FakeResponse {
  bodies: string[];
}

function fakeSseResponse(bodies: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const body of bodies) controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function clientWithResponses(responses: FakeResponse[]) {
  const calls: Recorded[] = [];
  let index = 0;
  const hot = new HotClient({
    baseUrl: "http://hot.test",
    token: "test-token",
    fetch: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      calls.push({
        method: init?.method ?? "GET",
        pathname: new URL(url).pathname,
      });
      const response = responses[index++];
      if (!response) {
        throw new Error(`Unexpected request: ${init?.method} ${url}`);
      }
      return fakeSseResponse(response.bodies);
    },
  });
  return { hot, calls };
}

async function collect(iter: AsyncGenerator<StreamEvent, void, undefined>) {
  const out: StreamEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe("streams.subscribeWithEvent reconnect", () => {
  it("reconnects via stream_id after server timeout and yields run:stop", async () => {
    const { hot, calls } = clientWithResponses([
      {
        bodies: [
          'data: {"type":"event:published","stream_id":"s1","event_id":"e1","event_type":"x"}\n\n',
          'data: {"type":"run:start","run":{"run_id":"r1"}}\n\n',
        ],
      },
      {
        bodies: [
          'data: {"type":"run:start","run":{"run_id":"r1"}}\n\n',
          'data: {"type":"run:stop","run":{"run_id":"r1","result":"done"}}\n\n',
        ],
      },
    ]);

    const events = await collect(
      hot.streams.subscribeWithEvent({
        event_type: "team-agent:ask",
        event_data: {},
      }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "event:published",
      "run:start",
      "run:stop",
    ]);
    expect(calls).toEqual([
      { method: "POST", pathname: "/v1/streams/subscribe-with-event" },
      { method: "GET", pathname: "/v1/streams/s1/subscribe" },
    ]);
  });

  it("does not reconnect when reconnect: false", async () => {
    const { hot, calls } = clientWithResponses([
      {
        bodies: [
          'data: {"type":"event:published","stream_id":"s1","event_id":"e1","event_type":"x"}\n\n',
          'data: {"type":"run:start","run":{"run_id":"r1"}}\n\n',
        ],
      },
    ]);

    const events = await collect(
      hot.streams.subscribeWithEvent(
        { event_type: "x", event_data: {} },
        { reconnect: false },
      ),
    );

    expect(events.map((e) => e.type)).toEqual([
      "event:published",
      "run:start",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("dedupes run:start and terminal events by run_id across reconnects", async () => {
    const { hot } = clientWithResponses([
      {
        bodies: [
          'data: {"type":"event:published","stream_id":"s1","event_id":"e1","event_type":"x"}\n\n',
          'data: {"type":"run:start","run":{"run_id":"r1"}}\n\n',
        ],
      },
      {
        bodies: [
          'data: {"type":"run:start","run":{"run_id":"r1"}}\n\n',
          'data: {"type":"run:start","run":{"run_id":"r2"}}\n\n',
          'data: {"type":"run:fail","run":{"run_id":"r1","result":"err"}}\n\n',
          'data: {"type":"run:fail","run":{"run_id":"r1","result":"err"}}\n\n',
        ],
      },
    ]);

    const events = await collect(
      hot.streams.subscribeWithEvent({ event_type: "x", event_data: {} }),
    );

    const startIds = events
      .filter((e) => e.type === "run:start")
      .map((e) => (e as { run?: { run_id?: string } }).run?.run_id);
    const failIds = events
      .filter((e) => e.type === "run:fail")
      .map((e) => (e as { run?: { run_id?: string } }).run?.run_id);

    expect(startIds).toEqual(["r1", "r2"]);
    expect(failIds).toEqual(["r1"]);
  });

  it("throws if initial subscribe ends before event:published", async () => {
    const { hot } = clientWithResponses([{ bodies: [""] }]);

    await expect(
      collect(
        hot.streams.subscribeWithEvent({ event_type: "x", event_data: {} }),
      ),
    ).rejects.toThrow(/event:published/);
  });
});
