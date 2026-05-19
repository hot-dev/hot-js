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
      'data: {"type":"stream:complete"}\n\n',
    ].join("");
    const [events] = consumeSseBlocks(input);
    expect(events).toHaveLength(2);
  });

  it("preserves unknown typed events", () => {
    const input = 'data: {"type":"custom:event","value":1}\n\n';
    const [events] = consumeSseBlocks(input);
    expect(events).toEqual([{ type: "custom:event", value: 1 }]);
  });
});
