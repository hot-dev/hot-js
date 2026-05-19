import type { AgentEventDataInput } from "../types.js";

/** Strip a transport prefix (`web:user:abc` → `abc`). */
export function bareId(value: string): string {
  return value.replace(/^[^:]+:/, "");
}

export interface WebMessageIds {
  userBare: string;
  chatBare: string;
  sessionId: string;
  messageId: string;
}

export function buildWebMessageIds(input: {
  userId: string;
  chatId: string;
  sessionMode: "chat" | "person";
  messageIdPrefix?: string;
  now?: number;
}): WebMessageIds {
  const userBare = bareId(input.userId);
  const chatBare = bareId(input.chatId);
  const ts = input.now ?? Date.now();
  const prefix = input.messageIdPrefix ?? "web";

  const sessionId = input.sessionMode === "chat"
    ? `web:chat:${chatBare}`
    : `person:${userBare}`;

  return {
    userBare,
    chatBare,
    sessionId,
    messageId: `${prefix}:${chatBare}:${ts}`,
  };
}

/** Build the standard agent `event_data` envelope (identity + attachments + payload). */
export function buildAgentEventData(input: AgentEventDataInput): Record<string, unknown> {
  const data: Record<string, unknown> = {
    session_id: input.session_id,
    user_id: input.user_id,
    user_name: input.user_name ?? "User",
    message_id: input.message_id ?? `web:${Date.now()}`,
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    ...(input.payload ?? {}),
  };

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    data.metadata = input.metadata;
  }

  if (input.attachments && input.attachments.length > 0) {
    data.attachments = input.attachments;
  }

  return data;
}
