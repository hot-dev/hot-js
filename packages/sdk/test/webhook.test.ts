import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import { HotApiError } from "../src/errors.js";
import { VERSION } from "../src/version.js";
import { buildWebhookUrl, postWebhook } from "../src/webhook/index.js";

describe("buildWebhookUrl", () => {
  it("builds standard shared-domain webhook URLs with encoded segments", () => {
    expect(buildWebhookUrl("https://api.hot.dev///", {
      orgSlug: "acme",
      envName: "prod",
      service: "chat",
    })).toBe("https://api.hot.dev/webhook/acme/prod/chat/web/messages");

    expect(buildWebhookUrl("https://api.hot.dev", {
      orgSlug: "acme co",
      envName: "prod/1",
      service: "my bot",
      path: "/hooks/v1/incoming msg",
      token: "tok/1?x=2",
    })).toBe("https://api.hot.dev/webhook/acme%20co/prod%2F1/my%20bot/hooks/v1/incoming%20msg/tok%2F1%3Fx%3D2");
  });

  it("supports custom-domain webhook URLs via customDomain or omitted orgSlug/envName", () => {
    expect(buildWebhookUrl("https://hooks.example.com/", {
      customDomain: true,
      service: "twilio",
      path: "sms",
      token: "secret",
    })).toBe("https://hooks.example.com/webhook/twilio/sms/secret");

    expect(buildWebhookUrl("https://hooks.example.com", {
      service: "twilio",
    })).toBe("https://hooks.example.com/webhook/twilio/web/messages");
  });

  it("rejects empty, dot, traversal, or mismatched target segments with RangeError", () => {
    const badTargets = [
      { orgSlug: "", envName: "prod", service: "bot" },
      { orgSlug: ".", envName: "prod", service: "bot" },
      { orgSlug: "..", envName: "prod", service: "bot" },
      { orgSlug: "acme", envName: "..", service: "bot" },
      { orgSlug: "acme", envName: "prod", service: "." },
      { orgSlug: "acme", envName: "prod", service: "bot", path: "../secret" },
      { orgSlug: "acme", envName: "prod", service: "bot", path: "a//b" },
      { orgSlug: "acme", envName: "prod", service: "bot", path: "/" },
      { orgSlug: "acme", envName: "prod", service: "bot", token: ".." },
      { orgSlug: "acme", service: "bot" },
      { envName: "prod", service: "bot" },
    ];

    for (const target of badTargets) {
      expect(() => buildWebhookUrl("https://api.hot.dev", target), JSON.stringify(target))
        .toThrow(RangeError);
    }
  });
});

describe("postWebhook", () => {
  const message = {
    session_id: "web:chat:1",
    user_id: "web:user:u1",
    text: "hello",
  };

  it("sends POST with User-Agent, redirect: manual, no Authorization header, and parses JSON", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const hot = new HotClient({
      baseUrl: "https://api.hot.dev",
      token: "secret-bearer-token",
      fetch: async (input, init) => {
        seenUrl = String(input);
        seenInit = init;
        return Response.json({ ok: true, status: "response", text: "hi" });
      },
    });

    const result = await postWebhook(
      hot.http,
      { orgSlug: "acme", envName: "prod", service: "bot", token: "tok1" },
      message,
    );

    expect(result).toEqual({ ok: true, status: "response", text: "hi" });
    expect(seenUrl).toBe("https://api.hot.dev/webhook/acme/prod/bot/web/messages/tok1");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.redirect).toBe("manual");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("User-Agent")).toBe(`hot-sdk-js/${VERSION}`);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("throws HotApiError on 3xx redirects without following them", async () => {
    const hot = new HotClient({
      baseUrl: "https://api.hot.dev",
      token: "t",
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response("", {
          status: 302,
          headers: { Location: "https://evil.example/steal" },
        });
      },
    });

    const err = await postWebhook(hot.http, { service: "bot" }, message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HotApiError);
    expect((err as HotApiError).status).toBe(302);
    expect((err as HotApiError).headers.get("Location")).toBe("https://evil.example/steal");
  });

  it("enforces http.timeoutMs and aborts before calling fetch on invalid target", async () => {
    let fetchCalls = 0;
    const hot = new HotClient({
      baseUrl: "https://api.hot.dev",
      token: "t",
      timeoutMs: 80,
      fetch: (_input, init) => {
        fetchCalls += 1;
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      },
    });

    await expect(postWebhook(hot.http, { orgSlug: "..", envName: "prod", service: "bot" }, message))
      .rejects.toThrow(RangeError);
    expect(fetchCalls).toBe(0);

    await expect(postWebhook(hot.http, { service: "bot" }, message))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchCalls).toBe(1);
  });
});
