import assert from "node:assert/strict";
import { test } from "node:test";
import { createDesktopExecutor } from "../src/desktop-computer.ts";

const desk = (call: () => Promise<{ content: string; isError?: boolean }>) => ({ call });
const entry = (id: string, createdAt = Date.now()) => ({
  type: "tool_call",
  createdAt,
  payload: {
    client: true,
    tool: "desktop",
    callId: id,
    args: { code: "await computer.listApps()" },
  },
});

test("only the submitting desktop executes an active call, once despite duplicate snapshots", async () => {
  let actions = 0;
  const results: string[] = [];
  const execute = createDesktopExecutor(
    "mine",
    desk(async () => {
      actions++;
      return { content: "done" };
    }),
    async (id) => {
      results.push(id);
    },
  );
  const run = { desktopClientId: "other", status: "running", alive: true, activity: [entry("click")] };
  await execute(run);
  await execute({ ...run, desktopClientId: "mine", alive: false });
  await execute({ ...run, desktopClientId: "mine", status: "done" });
  assert.equal(actions, 0);
  await Promise.all([execute({ ...run, desktopClientId: "mine" }), execute({ ...run, desktopClientId: "mine" })]);
  assert.equal(actions, 1);
  assert.deepEqual(results, ["click"]);
});

test("completed or expired calls never execute", async () => {
  let actions = 0;
  const execute = createDesktopExecutor(
    "mine",
    desk(async () => {
      actions++;
      return { content: "done" };
    }),
    async () => {},
  );
  await execute({
    desktopClientId: "mine",
    status: "running",
    alive: true,
    activity: [entry("old", Date.now() - 60_000), entry("done"), { type: "tool_result", payload: { callId: "done" } }],
  });
  assert.equal(actions, 0);
});

test("a failed result submission does not replay the physical action", async () => {
  let actions = 0;
  const execute = createDesktopExecutor(
    "mine",
    desk(async () => {
      actions++;
      return { content: "done" };
    }),
    async () => {
      throw new Error("offline");
    },
  );
  const run = { desktopClientId: "mine", status: "running", alive: true, activity: [entry("click")] };
  await assert.rejects(execute(run), /offline/);
  await execute(run);
  assert.equal(actions, 1);
});

for (const ending of ["disconnect", "lease loss", "requeued"]) {
  test(`${ending} cancels an in-flight native action and never reconnects`, { timeout: 3000 }, async () => {
    const { serveDesktopRun } = await import("../src/desktop-computer.ts");
    const originalFetch = globalThis.fetch;
    const globals = globalThis as unknown as { window?: EventTarget };
    const originalWindow = globals.window;
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    let fetches = 0;
    let stream: ReadableStreamDefaultController<Uint8Array>;
    globals.window = Object.assign(new EventTarget(), {
      qmDesktop: {
        platform: "darwin",
        computer: {
          ...desk(async () => {
            started.resolve();
            await stopped.promise;
            return { content: "stopped", isError: true };
          }),
          stop: async () => {
            stopped.resolve();
          },
        },
      },
    });
    globalThis.fetch = async () => {
      fetches++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "CUSTOM", name: "run", value: { desktopClientId: "mine", status: "running", alive: true, activity: [entry("click")] } })}\n\n`,
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    try {
      const serving = serveDesktopRun(
        "run",
        "mine",
        (path) => `http://localhost${path}`,
        async () => {},
      );
      await started.promise;
      if (ending === "disconnect") stream!.close();
      else
        stream!.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ type: "CUSTOM", name: "run", value: { desktopClientId: "mine", status: ending === "requeued" ? "pending" : "running", alive: false, activity: [] } })}\n\n`,
          ),
        );
      await stopped.promise;
      await serving;
      assert.equal(fetches, 1);
    } finally {
      globalThis.fetch = originalFetch;
      globals.window = originalWindow;
    }
  });
}
