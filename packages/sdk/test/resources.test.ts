import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";

interface RecordedCall {
  method?: string;
  url: string;
}

function createRecordingClient() {
  const calls: RecordedCall[] = [];
  const hot = new HotClient({
    baseUrl: "http://hot.test",
    token: "test-token",
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({
        method: init?.method,
        url,
      });

      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Accept === "text/event-stream") {
        return new Response('data: {"type":"stream:complete","stream_id":"s1"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      return new Response(JSON.stringify({
        data: {},
        pagination: {
          total: 0,
          limit: 20,
          offset: 0,
          has_more: false,
        },
        meta: {},
      }), {
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  return { hot, calls };
}

describe("HotClient resource coverage", () => {
  it("routes files, projects, sessions, observability, and stream calls", async () => {
    const { hot, calls } = createRecordingClient();

    await hot.files.list({ prefix: "logs/", limit: 5 });
    await hot.files.get("file_1");
    await hot.files.download("file_1");
    await hot.blobs.download("blob_1");
    await hot.files.upload("logs/a b.txt", "hello");
    await hot.files.initiateUpload({ path: "logs/big.bin", expected_size: 10 });
    await hot.files.uploadPart("upload_1", 1, "part");
    await hot.files.completeUpload("upload_1");
    await hot.files.abortUpload("upload_1");
    await hot.files.delete("file_1");

    await hot.projects.list();
    await hot.projects.create({ name: "demo" });
    await hot.projects.get("demo");
    await hot.projects.update("demo", { name: "renamed" });
    await hot.projects.activate("demo");
    await hot.projects.deactivate("demo");
    await hot.projects.eventHandlers("demo");
    await hot.projects.schedules("demo");
    await hot.projects.delete("demo");

    await hot.builds.list();
    await hot.builds.listForProject("demo");
    await hot.builds.get("demo", "build_1");
    await hot.builds.deployed("demo");
    await hot.builds.live("demo");
    await hot.builds.upload("demo", {
      file: new Blob(["zip"]),
      filename: "build.hot.zip",
      hash: "abc123",
    });
    await hot.builds.download("demo", "build_1");
    await hot.builds.deploy("demo", "build_1");

    await hot.context.list("demo");
    await hot.context.create("demo", {
      key: "OPENAI_API_KEY",
      value: "secret",
      description: "OpenAI key",
    });
    await hot.context.update("demo", "OPENAI_API_KEY", { value: "new-secret" });
    await hot.context.delete("demo", "OPENAI_API_KEY");

    await hot.domains.create({ domain: "mcp.example.com" });
    await hot.domains.list();
    await hot.domains.get("domain_1");
    await hot.domains.verify("domain_1");
    await hot.domains.delete("domain_1");

    await hot.sessions.create({ permissions: {} });
    await hot.sessions.list();
    await hot.sessions.revoke("session_1");
    await hot.sessions.revokeAll();

    await hot.serviceKeys.create({ permissions: {}, name: "demo" });
    await hot.serviceKeys.list();
    await hot.serviceKeys.get("service_key_1");
    await hot.serviceKeys.update("service_key_1", { metadata: { purpose: "demo" } });
    await hot.serviceKeys.revoke("service_key_1");
    await hot.serviceKeys.revokeAll();

    await hot.runs.stats();
    await hot.org.usage();
    await hot.env.subscribe().next();
    await hot.streams.subscribe("stream_1", { project: "demo" }).next();
    await hot.streams.subscribePost("stream_1").next();
    await hot.streams.subscribeWithEvent({
      event_type: "demo:event",
      event_data: {},
    }).next();

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /v1/files",
      "GET /v1/files/file_1",
      "GET /v1/files/file_1/download",
      "GET /v1/blobs/blob_1/download",
      "PUT /v1/files/upload/logs/a%20b.txt",
      "POST /v1/files/uploads",
      "PUT /v1/files/uploads/upload_1/1",
      "POST /v1/files/uploads/upload_1/complete",
      "DELETE /v1/files/uploads/upload_1",
      "DELETE /v1/files/file_1",
      "GET /v1/projects",
      "POST /v1/projects",
      "GET /v1/projects/demo",
      "PATCH /v1/projects/demo",
      "POST /v1/projects/demo/activate",
      "POST /v1/projects/demo/deactivate",
      "GET /v1/projects/demo/event-handlers",
      "GET /v1/projects/demo/schedules",
      "DELETE /v1/projects/demo",
      "GET /v1/builds",
      "GET /v1/projects/demo/builds",
      "GET /v1/projects/demo/builds/build_1",
      "GET /v1/projects/demo/builds/deployed",
      "GET /v1/projects/demo/builds/live",
      "POST /v1/projects/demo/builds",
      "GET /v1/projects/demo/builds/build_1/download",
      "POST /v1/projects/demo/builds/build_1/deploy",
      "GET /v1/projects/demo/context",
      "POST /v1/projects/demo/context",
      "PUT /v1/projects/demo/context/OPENAI_API_KEY",
      "DELETE /v1/projects/demo/context/OPENAI_API_KEY",
      "POST /v1/domains",
      "GET /v1/domains",
      "GET /v1/domains/domain_1",
      "POST /v1/domains/domain_1/verify",
      "DELETE /v1/domains/domain_1",
      "POST /v1/sessions",
      "GET /v1/sessions",
      "DELETE /v1/sessions/session_1",
      "DELETE /v1/sessions",
      "POST /v1/service-keys",
      "GET /v1/service-keys",
      "GET /v1/service-keys/service_key_1",
      "PATCH /v1/service-keys/service_key_1",
      "DELETE /v1/service-keys/service_key_1",
      "DELETE /v1/service-keys",
      "GET /v1/runs/stats",
      "GET /v1/org/usage",
      "GET /v1/env/subscribe",
      "GET /v1/streams/stream_1/subscribe",
      "POST /v1/streams/stream_1/subscribe",
      "POST /v1/streams/subscribe-with-event",
    ]);
  });

  it("downloads a blob as a raw response with an encoded id and the caller's signal", async () => {
    const seen: { method?: string; url: string; signal?: AbortSignal | null }[] = [];
    const controller = new AbortController();
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async (input, init) => {
        seen.push({
          method: init?.method,
          url: input instanceof Request ? input.url : String(input),
          signal: init?.signal,
        });
        return new Response(new Uint8Array([0, 1, 2, 255]), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      },
    });

    const response = await hot.blobs.download("blob/ref 1", { signal: controller.signal });

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(new URL(seen[0]!.url).pathname).toBe("/v1/blobs/blob%2Fref%201/download");
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it("surfaces an API error when a blob download is refused", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "test-token",
      fetch: async () => new Response(
        JSON.stringify({ error: { code: "not_found", message: "blob not found" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    });

    await expect(hot.blobs.download("missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("server status", () => {
  const body = {
    status: "ok",
    service: "hot.dev api server",
    version: "3.0.4",
    git_sha: "133edc3",
    start_time: "2026-11-06T10:00:00Z",
  };

  it("reads GET /status from the server's root, not under /v1", async () => {
    const urls: string[] = [];
    const hot = new HotClient({
      baseUrl: "http://hot.test/",
      token: "hot_key",
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json(body);
      },
    });

    await expect(hot.status()).resolves.toEqual(body);
    expect(urls).toEqual(["http://hot.test/status"]);
  });

  it("retries a brief outage, as other JSON calls do", async () => {
    let calls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "hot_key",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response("busy", { status: 503, headers: { "Retry-After": "0" } })
          : Response.json(body);
      },
    });

    await expect(hot.status()).resolves.toEqual(body);
    expect(calls).toBe(2);
  });

  it("throws HotApiError when the server answers with an error", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "hot_key",
      fetch: async () => new Response("no", { status: 404 }),
    });

    await expect(hot.status()).rejects.toMatchObject({ status: 404 });
  });

  it("stops when the caller aborts", async () => {
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "hot_key",
      fetch: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return Response.json(body);
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("stopped"));

    await expect(hot.status({ signal: controller.signal })).rejects.toThrow("stopped");
  });
});

describe("run filters", () => {
  it("sends project, stream and function as query parameters", async () => {
    const urls: string[] = [];
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "hot_key",
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json({ data: [], pagination: { total: 0 }, meta: {} });
      },
    });

    await hot.runs.list({ project_id: "p-1", stream_id: "s-1", function: "::orders/on-placed" });

    const query = new URL(urls[0]!).searchParams;
    expect(query.get("project_id")).toBe("p-1");
    expect(query.get("stream_id")).toBe("s-1");
    expect(query.get("function")).toBe("::orders/on-placed");
  });
});

describe("event ids", () => {
  it("sends a caller's event_id, so a publish is safe to send again", async () => {
    const bodies: unknown[] = [];
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "hot_key",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ data: { event_id: "e-1" }, meta: {} });
      },
    });

    await hot.events.publish({ event_id: "e-1", event_type: "order:placed", event_data: {} });

    expect(bodies).toEqual([{ event_id: "e-1", event_type: "order:placed", event_data: {} }]);
  });
});

