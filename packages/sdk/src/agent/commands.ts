export interface CommandSpec {
  /** Typed event name, e.g. `team-agent:ask`. */
  event: string;
  /** Payload key for the command argument, e.g. `question`. */
  argKey?: string;
}

export type CommandMap = Record<string, CommandSpec>;

export interface ParsedCommand {
  event: string;
  payload: Record<string, unknown>;
  command?: string;
  isCommand: boolean;
}

export interface ParseSlashCommandOptions {
  /** Event used for non-command text, e.g. `team-agent:record`. */
  fallbackEvent: string;
  /** Payload key for fallback text, default `text`. */
  fallbackKey?: string;
}

const SLASH_RE = /^\/([\w-]+)(?:\s+([\s\S]*))?$/;

/**
 * Map user text to a typed agent event + payload.
 * Unknown slash commands fall through to the fallback event.
 */
export function parseSlashCommand(
  text: string,
  commands: CommandMap,
  options: ParseSlashCommandOptions,
): ParsedCommand {
  const trimmed = text.trim();
  const fallbackKey = options.fallbackKey ?? "text";

  if (trimmed.startsWith("/")) {
    const match = SLASH_RE.exec(trimmed);
    const name = (match?.[1] ?? "").toLowerCase();
    const arg = (match?.[2] ?? "").trim();
    const spec = commands[name];

    if (spec) {
      const payload: Record<string, unknown> = { command: name };
      if (spec.argKey) payload[spec.argKey] = arg;
      return {
        event: spec.event,
        payload,
        command: name,
        isCommand: true,
      };
    }
  }

  return {
    event: options.fallbackEvent,
    payload: { [fallbackKey]: trimmed },
    isCommand: false,
  };
}
