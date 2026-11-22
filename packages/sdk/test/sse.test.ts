import { describe, expect, it } from "vitest";
import {
  consumeSseBlocks,
  consumeSseResponse,
  extractBlockData,
  splitSseBlocks,
  StreamIdleError,
} from "../src/streaming/sse.js";

function streamFromChunks(chunks: Array<string | Uint8Array>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

describe("consumeSseBlocks", () => {
  it("parses single SSE data block", () => {
    const input = 'data: {"type":"run:start","run":{"run_id":"r1"}}\n\n';
    const [events, rest] = consumeSseBlocks(input);
    expect(rest).toBe("");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run:start");
  });

  it("buffers incomplete blocks", () => {
    const input = 'data: {"type":"run:';
    const [events, rest] = consumeSseBlocks(input);
    expect(events).toHaveLength(0);
    expect(rest).toBe(input);
  });

  it("parses multiple blocks in one buffer", () => {
    const input = [
      'data: {"type":"event:published","event_id":"e1"}\n\n',
      'data: {"type":"stream:complete","stream_id":"s1"}\n\n',
    ].join("");
    const [events] = consumeSseBlocks(input);
    expect(events).toHaveLength(2);
  });

  it("wraps unknown typed events so StreamEvent narrows on type", () => {
    const input = 'data: {"type":"custom:event","value":1}\n\n';
    const [events] = consumeSseBlocks(input);
    expect(events).toEqual([
      { type: "unknown", event_type: "custom:event", data: { type: "custom:event", value: 1 } },
    ]);
  });

  it("narrows known events at compile time", () => {
    const [events] = consumeSseBlocks(
      'data: {"type":"run:stop","run":{"run_id":"r1","result":{"answer":42}}}\n\n'
      + 'data: {"type":"stream:data","run_id":"r1","data_type":"ai:delta","payload":{"text":"hi"}}\n\n',
    );
    const seen: unknown[] = [];
    for (const event of events) {
      // These property accesses only compile when the union narrows.
      if (event.type === "run:stop") seen.push(event.run?.result);
      if (event.type === "stream:data") {
        const text = event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>).text
          : undefined;
        seen.push(text, event.data_type);
      }
      if (event.type === "unknown") seen.push(event.event_type);
    }
    expect(seen).toEqual([{ answer: 42 }, "hi", "ai:delta"]);
  });

  it("handles \\r\\n\\r\\n and \\r\\r event delimiters", () => {
    const crlf = 'data: {"type":"event:published","event_id":"e1"}\r\n\r\n'
      + 'data: {"type":"stream:complete","stream_id":"s1"}\r\n\r\n';
    const [crlfEvents, crlfRest] = consumeSseBlocks(crlf);
    expect(crlfRest).toBe("");
    expect(crlfEvents.map((e) => e.type)).toEqual(["event:published", "stream:complete"]);

    const cr = 'data: {"type":"event:published","event_id":"e2"}\r\r'
      + 'data: {"type":"stream:complete","stream_id":"s2"}\r\r';
    const [crEvents, crRest] = consumeSseBlocks(cr);
    expect(crRest).toBe("");
    expect(crEvents.map((e) => e.type)).toEqual(["event:published", "stream:complete"]);
  });

  it("joins multiple data: lines with '\\n' per WHATWG SSE §9.2.6", () => {
    expect(extractBlockData(["data: line1", "data: line2", "data:line3"])).toBe("line1\nline2\nline3");

    const prettyJson = [
      "data: {",
      'data:   "type": "run:start",',
      'data:   "run": { "run_id": "r1" }',
      "data: }",
      "",
      "",
    ].join("\r\n");
    const [events, rest] = consumeSseBlocks(prettyJson);
    expect(rest).toBe("");
    expect(events).toEqual([{ type: "run:start", run: { run_id: "r1" } }]);

    // If joined with "" instead of "\n", this broken JSON string would silently concatenate into "ab".
    const brokenString = 'data: {"type":"stream:data","data_type":"x","payload":{"text":"a\ndata: b"}}\n\n';
    const [blocks] = splitSseBlocks(brokenString);
    expect(blocks[0]?.data).toBe('{"type":"stream:data","data_type":"x","payload":{"text":"a\nb"}}');
    const [badEvents] = consumeSseBlocks(brokenString);
    expect(badEvents).toEqual([]);
  });

  it("strips leading UTF-8 BOM on the first line", () => {
    const [events, rest] = consumeSseBlocks('\uFEFFdata: {"type":"keepalive"}\n\n');
    expect(rest).toBe("");
    expect(events).toEqual([{ type: "keepalive" }]);
  });

  it("enforces max buffer cap rather than growing unboundedly", () => {
    expect(() => splitSseBlocks("data: " + "x".repeat(128), false, 64)).toThrow(/SSE buffer exceeded/);
  });
});

describe("consumeSseResponse", () => {
  it("handles chunk boundaries splitting \\r\\n\\r\\n and leading UTF-8 BOM bytes", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const chunks: Array<string | Uint8Array> = [
      bom,
      'data: {"type":"event:published","event_id":"e1"}\r',
      '\n\r',
      '\ndata: {\r\ndata:   "type":"stream:complete",\r\ndata:   "stream_id":"s1"\r\ndata: }\r\n\r\n',
    ];
    const events = [];
    for await (const event of consumeSseResponse(async () => streamFromChunks(chunks))) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "event:published", event_id: "e1" },
      { type: "stream:complete", stream_id: "s1" },
    ]);
  });

  it("enforces maxBufferBytes during streaming without affecting multi-event streams", async () => {
    const okEvents = [];
    for await (const event of consumeSseResponse(
      async () => streamFromChunks([
        'data: {"type":"keepalive"}\n\n',
        'data: {"type":"keepalive"}\n\n',
        'data: {"type":"keepalive"}\n\n',
      ]),
      { maxBufferBytes: 40 },
    )) {
      okEvents.push(event);
    }
    expect(okEvents).toHaveLength(3);

    const overflow = async () => {
      for await (const _ of consumeSseResponse(
        async () => streamFromChunks(["data: " + "a".repeat(30), "b".repeat(30)]),
        { maxBufferBytes: 40 },
      )) {
        // drain
      }
    };
    await expect(overflow()).rejects.toThrow(/SSE buffer exceeded/);
  });

  it("races options.signal and idleTimeoutMs without leaking unhandled rejections", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // Case 1: AbortSignal fires while reader.read() is stuck pending.
      let cancelCount = 0;
      const hangingResponse = () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancelCount += 1;
          throw new Error("cancel failed");
        },
      }));

      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("user stopped")), 20);
      const runAbort = async () => {
        for await (const _ of consumeSseResponse(async () => hangingResponse(), { signal: controller.signal })) {
          // wait
        }
      };
      await expect(runAbort()).rejects.toThrow("user stopped");
      expect(cancelCount).toBe(1);

      // Case 2: idleTimeoutMs fires while reader.read() is pending and later rejects on cancel.
      let pullReject: ((err: Error) => void) | undefined;
      const idleResponse = () => new Response(new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>((_, reject) => {
            pullReject = reject;
          });
        },
        cancel() {
          pullReject?.(new Error("stream cancelled after timeout"));
        },
      }));

      const runIdle = async () => {
        for await (const _ of consumeSseResponse(async () => idleResponse(), { idleTimeoutMs: 30 })) {
          // wait
        }
      };
      await expect(runIdle()).rejects.toBeInstanceOf(StreamIdleError);

      // Give microtasks a turn to surface any unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
