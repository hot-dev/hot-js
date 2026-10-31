import { describe, expect, it } from "vitest";
import { consumeSseBlocks } from "../src/streaming/sse.js";

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
      if (event.type === "stream:data") seen.push(event.payload?.text, event.data_type);
      if (event.type === "unknown") seen.push(event.event_type);
    }
    expect(seen).toEqual([{ answer: 42 }, "hi", "ai:delta"]);
  });
});
