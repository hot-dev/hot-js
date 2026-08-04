// Integration tests against a live `hot dev` instance serving the fixture
// project in integration/fixture. Start one and run this file with
// integration/run.sh; without HOT_TEST_API_KEY set, the suite is skipped.
import { describe, expect, it } from "vitest";
import { HotClient } from "../src/client.js";

const apiKey = process.env.HOT_TEST_API_KEY;
const baseUrl = process.env.HOT_TEST_BASE_URL ?? "http://localhost:4681";

function client(): HotClient {
  return new HotClient({ token: apiKey!, baseUrl });
}

describe.skipIf(!apiKey)("hot dev integration", () => {
  it("reads env and projects", { timeout: 30_000 }, async () => {
    const hot = client();

    const env = await hot.env.get();
    expect(env.name).toBe("development");

    const projects = await hot.projects.list();
    expect(projects.data.map((project) => project.name)).toContain("sdk-fixture");
  });

  it("echoes a payload through subscribeWithEvent", { timeout: 60_000 }, async () => {
    const hot = client();

    let result: unknown;
    for await (const event of hot.streams.subscribeWithEvent({
      event_type: "sdk:echo",
      event_data: { text: "hello" },
    })) {
      if (event.type === "run:fail" || event.type === "run:cancel") {
        throw new Error(`run did not complete: ${JSON.stringify(event)}`);
      }
      if (event.type === "run:stop") {
        result = event.run?.result;
        break;
      }
    }

    expect(result).toEqual({ echoed: { text: "hello" } });
  });

  it("waits for a task started by an event handler", { timeout: 90_000 }, async () => {
    const hot = client();

    let taskId: string | undefined;
    let handlerRunId: string | undefined;
    let streamId: string | undefined;
    for await (const event of hot.streams.subscribeWithEvent({
      event_type: "sdk:task",
      event_data: { value: "hello" },
    })) {
      if (event.type === "run:fail" || event.type === "run:cancel") {
        throw new Error(`run did not complete: ${JSON.stringify(event)}`);
      }
      if (event.type === "run:stop") {
        const result = event.run?.result as { work?: { task?: string } } | undefined;
        taskId = result?.work?.task;
        handlerRunId = event.run?.run_id;
        streamId = event.run?.stream_id;
        break;
      }
    }

    expect(taskId).toBeTypeOf("string");
    const handlerRun = await hot.runs.wait(handlerRunId!, { timeoutMs: 60_000 });
    expect(handlerRun.status).toBe("succeeded");

    let streamedTask: unknown;
    for await (const event of hot.streams.subscribe(streamId!)) {
      if (event.type === "task:update" && event.task.task_id === taskId) {
        if (["failed", "cancelled", "timed_out"].includes(event.task.status)) {
          throw new Error(`task did not complete: ${JSON.stringify(event.task)}`);
        }
        if (event.task.status === "completed") {
          streamedTask = event.task;
          break;
        }
      }
    }
    expect(streamedTask).toMatchObject({ status: "completed", result: { processed: "hello" } });

    const task = await hot.tasks.wait(taskId!, { timeoutMs: 60_000 });
    expect(task.status).toBe("completed");
    expect(task.result).toEqual({ processed: "hello" });
  });

  it("calls a Hot function via callHot", { timeout: 60_000 }, async () => {
    const hot = client();
    await expect(hot.events.callHot("::fixture::sdk/add-nums", [2, 3])).resolves.toBe(5);
  });

  it("surfaces run failure messages", { timeout: 60_000 }, async () => {
    const hot = client();
    await expect(hot.events.callHot("::fixture::sdk/always-fail")).rejects.toThrow(
      "sdk fixture failure",
    );
  });
});
