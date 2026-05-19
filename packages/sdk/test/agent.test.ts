import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../src/agent/commands.js";
import { buildAgentEventData, buildWebMessageIds } from "../src/agent/event-data.js";

describe("parseSlashCommand", () => {
  const commands = {
    ask: { event: "team-agent:ask", argKey: "question" },
    guide: { event: "team-agent:guide" },
  };

  it("maps known slash commands", () => {
    const parsed = parseSlashCommand("/ask what is up?", commands, {
      fallbackEvent: "team-agent:record",
    });
    expect(parsed.event).toBe("team-agent:ask");
    expect(parsed.payload.question).toBe("what is up?");
    expect(parsed.isCommand).toBe(true);
  });

  it("falls back for plain text", () => {
    const parsed = parseSlashCommand("hello team", commands, {
      fallbackEvent: "team-agent:record",
    });
    expect(parsed.event).toBe("team-agent:record");
    expect(parsed.payload.text).toBe("hello team");
    expect(parsed.isCommand).toBe(false);
  });
});

describe("buildAgentEventData", () => {
  it("builds identity envelope", () => {
    const ids = buildWebMessageIds({
      userId: "web:user:abc",
      chatId: "chat-1",
      sessionMode: "chat",
      now: 1_700_000_000_000,
    });

    expect(ids.sessionId).toBe("web:chat:chat-1");

    const data = buildAgentEventData({
      session_id: ids.sessionId,
      user_id: "web:user:abc",
      user_name: "Pat",
      message_id: ids.messageId,
      payload: { question: "hi" },
      metadata: { client: "test" },
    });

    expect(data.session_id).toBe("web:chat:chat-1");
    expect(data.question).toBe("hi");
    expect(data.metadata).toEqual({ client: "test" });
  });
});
