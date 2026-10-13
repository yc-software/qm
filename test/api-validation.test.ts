import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start(): { base: string; app: ReturnType<typeof buildApp>["app"]; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "apival-")) }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, app: built.app, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const post = (base: string, path: string, body: string) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body });

test("malformed request bodies are 400", async () => {
  const s = start();
  try {
    assert.equal((await post(s.base, "/v1/turns", JSON.stringify({ text: "hi" }))).status, 400);
    assert.equal((await post(s.base, "/v1/turns", "{not json")).status, 400);
    assert.equal((await post(s.base, "/v1/grants", JSON.stringify({ path: "x" }))).status, 400);
    assert.equal((await post(s.base, "/v1/deployments", JSON.stringify({ entrypoint: "x" }))).status, 400);
    assert.equal((await post(s.base, "/v1/crons", JSON.stringify({ action: "x" }))).status, 400);
  } finally {
    await s.close();
  }
});

test("unknown resources are 404, not silent 200 or 500", async () => {
  const s = start();
  try {
    assert.equal((await post(s.base, "/v1/deployments/nope/rollback", JSON.stringify({ version: 1 }))).status, 404);
    assert.equal((await post(s.base, "/v1/deployments/nope/archive", "")).status, 404);
    assert.equal((await post(s.base, "/v1/crons/nope/disable", "")).status, 404);
    assert.equal((await fetch(`${s.base}/v1/sessions/nope?viewer=someone`)).status, 404);
    assert.equal((await fetch(`${s.base}/v1/sessions/nope`)).status, 400);
    assert.equal((await fetch(`${s.base}/v1/unknown-route`)).status, 404);
  } finally {
    await s.close();
  }
});

test("invalid turn shapes are rejected before creating work", async () => {
  const s = start();
  const valid = {
    surface: "web",
    actor: { externalId: "reader@example.com" },
    conversation: { kind: "dm", threadRef: "web:test" },
    text: "hello",
  };
  const cases = [
    { ...valid, conversation: { kind: "dm", threadRef: 4 } },
    { ...valid, conversation: { kind: "unknown", threadRef: "web:test" } },
    { ...valid, conversation: { kind: "dm", threadRef: "web:\u0000test" } },
    { ...valid, attachments: {} },
    { ...valid, attachments: [{ name: "image.png" }] },
    { ...valid, attachments: [{ name: "image.png", mimetype: "image/png", blobId: "blob", sizeBytes: -1 }] },
  ];
  try {
    for (const request of cases) assert.equal((await post(s.base, "/v1/turns", JSON.stringify(request))).status, 400);
  } finally {
    await s.close();
  }
});

test("malformed core paths and NUL URL parameters return client errors", async () => {
  const s = start();
  try {
    for (const path of [
      "/v1/crons/%E0%A4%A",
      "/d/%E0%A4%A",
      "/v1/files?cursor=%00",
      "/v1/loops/%00",
      "/v1/webhooks/incoming/%00",
      "/d/%00",
    ]) {
      const response = await fetch(s.base + path);
      assert.equal(response.status, 400, path);
    }
    assert.notEqual((await fetch(s.base + "/d/missing-app/own%00path?value=%00")).status, 400);
  } finally {
    await s.close();
  }
});

test("pasted NUL text is normalized before the turn is admitted", async (t) => {
  const s = start();
  let captured = "";
  t.mock.method(s.app, "turn", async (request: { text: string }) => {
    captured = request.text;
    return { status: "refused", reason: "test admission" };
  });
  try {
    const response = await post(
      s.base,
      "/v1/turns?async=1",
      JSON.stringify({
        surface: "web",
        actor: { externalId: "reader@example.com" },
        conversation: { kind: "dm", threadRef: "web:nul-text" },
        text: "before\u0000after",
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(captured, "beforeafter");
  } finally {
    await s.close();
  }
});
