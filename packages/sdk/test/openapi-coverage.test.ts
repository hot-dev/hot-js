import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";
import operations from "./fixtures/openapi-operations.json";

interface OpenApiOperation {
  method: string;
  path: string;
}

type CoverageEntry =
  | { sdk: string }
  | {
      ignored: true;
      reason: string;
    };

const coverage: Record<string, CoverageEntry> = {
  "GET /status": {
    ignored: true,
    reason: "Public health endpoint, not part of authenticated SDK Layer 1 resources.",
  },
  "GET /v1/projects": { sdk: "projects.list" },
  "POST /v1/projects": { sdk: "projects.create" },
  "GET /v1/projects/{project_id_or_slug}": { sdk: "projects.get" },
  "PATCH /v1/projects/{project_id_or_slug}": { sdk: "projects.update" },
  "DELETE /v1/projects/{project_id_or_slug}": { sdk: "projects.delete" },
  "POST /v1/projects/{project_id_or_slug}/activate": { sdk: "projects.activate" },
  "POST /v1/projects/{project_id_or_slug}/deactivate": { sdk: "projects.deactivate" },
  "GET /v1/builds": { sdk: "builds.list" },
  "GET /v1/projects/{project_id_or_slug}/builds": { sdk: "builds.listForProject" },
  "POST /v1/projects/{project_id_or_slug}/builds": { sdk: "builds.upload" },
  "GET /v1/projects/{project_id_or_slug}/builds/deployed": { sdk: "builds.deployed" },
  "GET /v1/projects/{project_id_or_slug}/builds/live": { sdk: "builds.live" },
  "GET /v1/projects/{project_id_or_slug}/builds/{build_id}": { sdk: "builds.get" },
  "GET /v1/projects/{project_id_or_slug}/builds/{build_id}/download": { sdk: "builds.download" },
  "POST /v1/projects/{project_id_or_slug}/builds/{build_id}/deploy": { sdk: "builds.deploy" },
  "GET /v1/projects/{project_id_or_slug}/context": { sdk: "context.list" },
  "POST /v1/projects/{project_id_or_slug}/context": { sdk: "context.create" },
  "PUT /v1/projects/{project_id_or_slug}/context/{key}": { sdk: "context.update" },
  "DELETE /v1/projects/{project_id_or_slug}/context/{key}": { sdk: "context.delete" },
  "GET /v1/runs": { sdk: "runs.list" },
  "GET /v1/runs/stats": { sdk: "runs.stats" },
  "GET /v1/runs/{run_id}": { sdk: "runs.get" },
  "GET /v1/runs/{run_id}/subscribe": { sdk: "runs.subscribe" },
  "GET /v1/tasks/{task_id}": { sdk: "tasks.get" },
  "GET /v1/tasks/{task_id}/subscribe": { sdk: "tasks.subscribe" },
  "POST /v1/events": { sdk: "events.publish" },
  "GET /v1/events": { sdk: "events.list" },
  "GET /v1/events/{event_id}": { sdk: "events.get" },
  "GET /v1/events/{event_id}/runs": { sdk: "events.getRuns" },
  "GET /v1/projects/{project_id_or_slug}/event-handlers": { sdk: "projects.eventHandlers" },
  "GET /v1/projects/{project_id_or_slug}/schedules": { sdk: "projects.schedules" },
  "POST /v1/sessions": { sdk: "sessions.create" },
  "GET /v1/sessions": { sdk: "sessions.list" },
  "DELETE /v1/sessions": { sdk: "sessions.revokeAll" },
  "DELETE /v1/sessions/{session_id}": { sdk: "sessions.revoke" },
  "POST /v1/service-keys": { sdk: "serviceKeys.create" },
  "GET /v1/service-keys": { sdk: "serviceKeys.list" },
  "DELETE /v1/service-keys": { sdk: "serviceKeys.revokeAll" },
  "GET /v1/service-keys/{service_key_id}": { sdk: "serviceKeys.get" },
  "PATCH /v1/service-keys/{service_key_id}": { sdk: "serviceKeys.update" },
  "DELETE /v1/service-keys/{service_key_id}": { sdk: "serviceKeys.revoke" },
  "POST /v1/domains": { sdk: "domains.create" },
  "GET /v1/domains": { sdk: "domains.list" },
  "GET /v1/domains/{domain_id}": { sdk: "domains.get" },
  "DELETE /v1/domains/{domain_id}": { sdk: "domains.delete" },
  "POST /v1/domains/{domain_id}/verify": { sdk: "domains.verify" },
  "GET /v1/env": { sdk: "env.get" },
  "GET /v1/env/subscribe": { sdk: "env.subscribe" },
  "GET /v1/org/usage": { sdk: "org.usage" },
  "GET /v1/streams/{stream_id}/subscribe": { sdk: "streams.subscribe" },
  "POST /v1/streams/{stream_id}/subscribe": { sdk: "streams.subscribePost" },
  "POST /v1/streams/subscribe-with-event": { sdk: "streams.subscribeWithEvent" },
  "GET /v1/files": { sdk: "files.list" },
  "GET /v1/files/{file_id}": { sdk: "files.get" },
  "DELETE /v1/files/{file_id}": { sdk: "files.delete" },
  "GET /v1/files/{file_id}/download": { sdk: "files.download" },
  "PUT /v1/files/upload/{path}": { sdk: "files.upload" },
  "POST /v1/files/uploads": { sdk: "files.initiateUpload" },
  "PUT /v1/files/uploads/{upload_id}/{part_number}": { sdk: "files.uploadPart" },
  "POST /v1/files/uploads/{upload_id}/complete": { sdk: "files.completeUpload" },
  "DELETE /v1/files/uploads/{upload_id}": { sdk: "files.abortUpload" },
};

const hot = new HotClient({
  baseUrl: "http://hot.test",
  token: "test-token",
  fetch: async () => new Response(JSON.stringify({
    data: {},
    pagination: {
      total: 0,
      limit: 20,
      offset: 0,
      has_more: false,
    },
    meta: {
      request_id: "req_test",
      timestamp: "2026-01-01T00:00:00Z",
    },
  })),
});

describe("OpenAPI route coverage", () => {
  it("documents SDK coverage or an explicit ignore for every OpenAPI operation", () => {
    const openApiKeys = (operations as OpenApiOperation[]).map(operationKey);
    const coverageKeys = Object.keys(coverage);

    expect(coverageKeys.toSorted()).toEqual(openApiKeys.toSorted());
  });

  it("points covered operations at existing SDK methods", () => {
    for (const [key, entry] of Object.entries(coverage)) {
      if ("ignored" in entry) {
        expect(entry.reason, key).toBeTruthy();
        continue;
      }

      expect(resolveSdkMethod(entry.sdk), `${key} -> hot.${entry.sdk}`).toBeTypeOf("function");
    }
  });
});

function operationKey(operation: OpenApiOperation): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

function resolveSdkMethod(path: string): unknown {
  let value: unknown = hot;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null || !(part in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
