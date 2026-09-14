import assert from "node:assert/strict";
import test from "node:test";
import { suggestedActivityRoutes } from "../src/api/routes/suggested-activities.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

async function request(body: unknown, enabled: boolean, actor = "alice") {
  let status = 0;
  let result: unknown;
  let calls = 0;
  const route = suggestedActivityRoutes.find((entry) => "method" in entry && entry.method === "POST")!;
  assert.equal(route.auth, "source");
  await route.handle({
    body,
    actor: { p: actor, exp: Date.now() + 1000 },
    deps: enabled
      ? {
          suggestedActivities: async () => {
            calls++;
            return [];
          },
        }
      : {},
    res: {
      writeHead: (code: number) => {
        status = code;
      },
      end: (text: string) => {
        result = JSON.parse(text);
      },
    },
  } as unknown as ApiCtx);
  return { status, result, calls };
}

test("disabled generation cannot call a model", async () => {
  assert.deepEqual(await request({ principalId: "alice" }, false), {
    status: 404,
    result: { error: "not_found" },
    calls: 0,
  });
});

test("signed actor cannot generate for another principal", async () => {
  assert.deepEqual(await request({ principalId: "bob" }, true), {
    status: 403,
    result: { error: "forbidden" },
    calls: 0,
  });
});

test("generation validates inputs before invoking the model", async () => {
  for (const body of [{}, { principalId: "" }, { principalId: "alice", seeds: [{}] }]) {
    assert.equal((await request(body, true)).status, 400);
  }
  assert.deepEqual(await request({ principalId: "alice" }, true), {
    status: 200,
    result: { activities: [] },
    calls: 1,
  });
});
