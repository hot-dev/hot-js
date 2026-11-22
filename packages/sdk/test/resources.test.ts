import { describe, expect, it } from "vitest";
import {
  HotClient,
  HttpClient,
  type ApiKeyStatus,
  type BuildRecord,
  type BuildRuntimeWarning,
  type RequestOptions,
  type RunRecord,
  type TaskUpdateEvent,
} from "../src/index.js";
import type { ConsumeSseOptions, TaskUpdateEvent as StreamingTaskUpdateEvent } from "../src/streaming/index.js";
import type { ParseSlashCommandOptions, WebMessageIds } from "../src/agent/index.js";
import { VERSION } from "../src/version.js";

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

      const headers = new Headers(init?.headers);
      if (headers.get("Accept") === "text/event-stream") {
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

  it("reads GET /status from the server's root without sending an Authorization header", async () => {
    const urls: string[] = [];
    const seenHeaders: Headers[] = [];
    const hot = new HotClient({
      baseUrl: "http://hot.test/",
      token: "hot_key",
      fetch: async (input, init) => {
        urls.push(String(input));
        seenHeaders.push(new Headers(init?.headers));
        return Response.json(body);
      },
    });

    await expect(hot.status()).resolves.toEqual(body);
    expect(urls).toEqual(["http://hot.test/status"]);
    expect(seenHeaders[0]!.has("Authorization")).toBe(false);
    expect(seenHeaders[0]!.get("User-Agent")).toBe(`hot-sdk-js/${VERSION}`);
    expect(seenHeaders[0]!.get("Accept")).toBe("application/json");
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

describe("path validation and encoding", () => {
  it("rejects empty, dot, and traversal path segments locally before calling fetch", async () => {
    let fetchCalls = 0;
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "t",
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({ data: {}, meta: {} });
      },
    });

    await expect(hot.sessions.revoke(".")).rejects.toThrow(RangeError);
    await expect(hot.tasks.get("..")).rejects.toThrow(RangeError);
    await expect(hot.runs.get("..")).rejects.toThrow(RangeError);
    await expect(hot.runs.get("")).rejects.toThrow(RangeError);
    await expect(hot.events.get(".")).rejects.toThrow(RangeError);
    await expect(hot.events.getRuns("..")).rejects.toThrow(RangeError);
    await expect(hot.files.upload("../x", "hi")).rejects.toThrow(RangeError);
    await expect(hot.files.upload("", "hi")).rejects.toThrow(RangeError);
    await expect(hot.files.upload("/", "hi")).rejects.toThrow(RangeError);
    await expect(hot.files.upload("/a//b", "hi")).rejects.toThrow(RangeError);
    await expect(hot.files.upload("a/./b", "hi")).rejects.toThrow(RangeError);
    await expect(hot.runs.wait("..")).rejects.toThrow(RangeError);
    await expect(hot.tasks.wait(".")).rejects.toThrow(RangeError);
    expect(() => hot.streams.subscribe("..")).toThrow(RangeError);
    expect(fetchCalls).toBe(0);
  });

  it("percent-encodes special characters in IDs and normalizes leading slash in file paths", async () => {
    const { hot, calls } = createRecordingClient();

    await hot.runs.get("../service-keys");
    await hot.events.get("a/b");
    await hot.events.getRuns("a/b");
    await hot.tasks.get("a/b?c=1");
    await hot.files.upload("/logs/a b.txt", "hello");

    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v1/runs/..%2Fservice-keys",
      "GET /v1/events/a%2Fb",
      "GET /v1/events/a%2Fb/runs",
      "GET /v1/tasks/a%2Fb%3Fc%3D1",
      "PUT /v1/files/upload/logs/a%20b.txt",
    ]);
  });
});

describe("HttpClient normalization, headers, token hiding, uploads, and pagination", () => {
  it("normalizes trailing slashes and /v1 in baseUrl and apiPath('v1/...')", async () => {
    const urls: string[] = [];
    const hot = new HotClient({
      baseUrl: "http://hot.test/v1///",
      token: "secret-key-123",
      fetch: async (input) => {
        urls.push(String(input));
        return Response.json({ data: {}, meta: {} });
      },
    });

    expect(hot.http).toBeInstanceOf(HttpClient);
    expect(hot.http.baseUrl).toBe("http://hot.test");
    expect(hot.apiBaseUrl).toBe("http://hot.test/v1");
    await hot.request("GET", "v1/env");
    await hot.request("GET", "/v1/runs/stats");
    await hot.status();
    expect(urls).toEqual([
      "http://hot.test/v1/env",
      "http://hot.test/v1/runs/stats",
      "http://hot.test/status",
    ]);

    // Token is accessible via getter but non-enumerable / hidden from JSON.stringify
    expect(hot.token).toBe("secret-key-123");
    expect(Object.keys(hot.http)).not.toContain("token");
    expect(JSON.stringify(hot)).not.toContain("secret-key-123");
  });

  it("merges Headers instances, tuple arrays, and case-variant headers without duplicates", async () => {
    const captured: Headers[] = [];
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "tok",
      fetch: async (_input, init) => {
        captured.push(new Headers(init?.headers));
        return Response.json({ data: {}, meta: {} });
      },
    });

    await hot.request("POST", "/events", {
      body: { a: 1 },
      headers: new Headers({ "content-type": "application/merge-patch+json", "X-Trace": "t1" }),
    });
    await hot.request("GET", "/env", {
      headers: [["accept", "application/vnd.hot+json"], ["x-tuple", "yes"]],
    });

    expect(captured[0]!.get("content-type")).toBe("application/merge-patch+json");
    expect(captured[0]!.get("x-trace")).toBe("t1");
    expect(captured[0]!.get("authorization")).toBe("Bearer tok");
    expect(captured[1]!.get("accept")).toBe("application/vnd.hot+json");
    expect(captured[1]!.get("x-tuple")).toBe("yes");
  });

  it("wraps non-Blob builds.upload inputs (Uint8Array, ArrayBuffer, string) into a Blob with filename", async () => {
    const uploads: Array<{ name: string; bytes: Uint8Array }> = [];
    const hot = new HotClient({
      baseUrl: "http://hot.test",
      token: "tok",
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        uploads.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        return Response.json({ data: { build_id: "b1" }, meta: {} });
      },
    });

    await hot.builds.upload("demo", { file: new Uint8Array([1, 2, 3]), hash: "h1", filename: "u8.zip" });
    await hot.builds.upload("demo", { file: new Uint8Array([4, 5]).buffer, hash: "h2", filename: "ab.zip" });
    await hot.builds.upload("demo", { file: "zip-text", hash: "h3" });

    expect(uploads.map((u) => u.name)).toEqual(["u8.zip", "ab.zip", "build.hot.zip"]);
    expect(Array.from(uploads[0]!.bytes)).toEqual([1, 2, 3]);
    expect(Array.from(uploads[1]!.bytes)).toEqual([4, 5]);
    expect(new TextDecoder().decode(uploads[2]!.bytes)).toBe("zip-text");
  });

  it("passes optional pagination ListQuery and preserves 1.3.0 { signal } call form", async () => {
    const { hot, calls } = createRecordingClient();
    const ac = new AbortController();

    await hot.orgs.listEnvs("org-1", { limit: 10, offset: 20 });
    await hot.context.list("demo", { limit: 5 });
    await hot.domains.list({ limit: 15, offset: 5 });
    await hot.projects.eventHandlers("demo", { limit: 25 });
    await hot.projects.schedules("demo", { offset: 3 });
    await hot.events.getRuns("evt-1", { limit: 7 });
    // Legacy 1.3.0 { signal } call form must not serialize `signal` as a query parameter
    await hot.domains.list({ signal: ac.signal });
    await hot.context.list("demo", { signal: ac.signal });

    expect(calls.map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual([
      "/v1/orgs/org-1/envs?limit=10&offset=20",
      "/v1/projects/demo/context?limit=5",
      "/v1/domains?limit=15&offset=5",
      "/v1/projects/demo/event-handlers?limit=25",
      "/v1/projects/demo/schedules?offset=3",
      "/v1/events/evt-1/runs?limit=7",
      "/v1/domains",
      "/v1/projects/demo/context",
    ]);
  });

  it("supports Hot API 3.0.14 types and public exports", () => {
    const disabledStatus: ApiKeyStatus = "disabled";
    const warning: BuildRuntimeWarning = {
      build_engine_version: "3.0.10",
      build_hot_std_version: "3.0.10",
      runtime_version: "3.0.14",
      message: "version mismatch",
    };
    const build: BuildRecord = {
      build_id: "b1",
      project_id: "p1",
      hash: "abc",
      size: 10,
      build_type: "hot",
      deployed: true,
      active: true,
      runtime_status: "ready",
      deployment_sequence: 1,
      runtime_error: null,
      runtime_warning: warning,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const run: RunRecord = {
      run_id: "r1",
      env_id: "e1",
      stream_id: "s1",
      build_id: null,
      run_type: "event",
      status: "succeeded",
      start_time: "2026-01-01T00:00:00Z",
      stop_time: null,
      origin_run_id: null,
      event_id: null,
      result: null,
      retry_attempt: 0,
    };
    const _reqOpts: RequestOptions = { headers: new Headers() };
    const _sseOpts: ConsumeSseOptions = { maxBufferBytes: 1024 };
    const _cmdOpts: ParseSlashCommandOptions = { fallbackEvent: "x" };
    const _ids: WebMessageIds = { userBare: "u", chatBare: "c", sessionId: "s", messageId: "m" };
    const _taskEvt: TaskUpdateEvent | StreamingTaskUpdateEvent | undefined = undefined;

    expect(disabledStatus).toBe("disabled");
    expect(build.runtime_status).toBe("ready");
    expect(run.project_id).toBeUndefined();
    expect([_reqOpts, _sseOpts, _cmdOpts, _ids, _taskEvt]).toHaveLength(5);
  });
});

