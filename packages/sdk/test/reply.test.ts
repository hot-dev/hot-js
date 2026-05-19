import { describe, expect, it } from "vitest";
import { foldAgentReply } from "../src/agent/reply.js";
import type { StreamEvent } from "../src/streaming/types.js";

async function* fakeStream(events: StreamEvent[]) {
  for (const evt of events) yield evt;
}

describe("foldAgentReply", () => {
  it("folds delta and end into final text", async () => {
    const events = fakeStream([
      { type: "event:published", stream_id: "s1", event_id: "e1" },
      { type: "run:start", run: { run_id: "r1", event_id: "e1" } as never },
      {
        type: "stream:data",
        run_id: "r1",
        data_type: "team-agent:reply:delta",
        payload: { delta: "Hello" },
      },
      {
        type: "stream:data",
        run_id: "r1",
        data_type: "team-agent:reply:delta",
        payload: { delta: " world" },
      },
      {
        type: "stream:data",
        run_id: "r1",
        data_type: "team-agent:reply:end",
        payload: { text: "Hello world!" },
      },
    ]);

    const chunks: string[] = [];
    let result;
    const gen = foldAgentReply(events, { label: "team-agent" });
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      if (next.value.type === "delta") chunks.push(next.value.text);
    }

    expect(chunks).toEqual(["Hello", " world"]);
    expect(result?.text).toBe("Hello world!");
    expect(result?.status).toBe("ok");
  });
});
