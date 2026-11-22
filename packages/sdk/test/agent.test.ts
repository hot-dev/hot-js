import { describe, expect, it } from "vitest";
import { parseSlashCommand } from "../src/agent/commands.js";
import { bareId, buildAgentEventData, buildWebMessageIds } from "../src/agent/event-data.js";

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

  it("does not match Object.prototype keys like /constructor or /toString", () => {
    for (const input of ["/constructor hello", "/toString", "/__proto__ test", "/valueOf"]) {
      const parsed = parseSlashCommand(input, commands, {
        fallbackEvent: "team-agent:record",
      });
      expect(parsed.isCommand, input).toBe(false);
      expect(parsed.event, input).toBe("team-agent:record");
      expect(parsed.payload.text, input).toBe(input);
    }
  });
});

describe("bareId & buildWebMessageIds", () => {
  it("strips multi-segment transport prefixes and builds person session IDs", () => {
    expect(bareId("web:user:abc")).toBe("abc");
    expect(bareId("web:abc")).toBe("abc");
    expect(bareId("chat-1")).toBe("chat-1");

    const person = buildWebMessageIds({
      userId: "web:user:abc",
      chatId: "web:chat:c1",
      sessionMode: "person",
      now: 1_700_000_000_000,
    });
    expect(person.userBare).toBe("abc");
    expect(person.chatBare).toBe("c1");
    expect(person.sessionId).toBe("person:abc");
    expect(person.messageId).toBe("web:c1:1700000000000");
  });
});

describe("buildAgentEventData", () => {
  it("builds identity envelope and prevents payload from overwriting identity fields", () => {
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
      timestamp: 1_700_000_000,
      payload: {
        question: "hi",
        session_id: "spoofed-session",
        user_id: "spoofed-user",
        user_name: "Spoofed",
        message_id: "spoofed-msg",
        timestamp: 0,
      },
      metadata: { client: "test" },
    });

    expect(data.session_id).toBe("web:chat:chat-1");
    expect(data.user_id).toBe("web:user:abc");
    expect(data.user_name).toBe("Pat");
    expect(data.message_id).toBe(ids.messageId);
    expect(data.timestamp).toBe(1_700_000_000);
    expect(data.question).toBe("hi");
    expect(data.metadata).toEqual({ client: "test" });
  });
});
