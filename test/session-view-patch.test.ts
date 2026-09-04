import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import type { Session } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-view-patch-")) }));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function newSession(base: string, threadRef: string): Promise<string> {
  const r = await fetch(`${base}/v1/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "hello",
    }),
  });
  const body = (await r.json()) as { status: string; sessionId?: string };
  assert.equal(body.status, "ok");
  return body.sessionId!;
}

async function patch(
  base: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; session?: Session; message?: string }> {
  const r = await fetch(`${base}/v1/sessions/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await r.json()) as { session?: Session; message?: string };
  return { status: r.status, ...parsed };
}

test("POST /v1/sessions/:id pins and colors the viewer's row; null clears; casing normalizes", async () => {
  const srv = start();
  try {
    const id = await newSession(srv.base, "web:U1:pin-color");

    const pinned = await patch(srv.base, id, { principalId: "U1", pinned: true, color: "#AaBbCc" });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.session?.pinned, true);
    assert.equal(pinned.session?.color, "#aabbcc", "color is normalized to lowercase");

    const cleared = await patch(srv.base, id, { principalId: "U1", pinned: false, color: null });
    assert.equal(cleared.status, 200);
    assert.ok(!cleared.session?.pinned);
    assert.equal(cleared.session?.color ?? null, null, "null clears the color");
  } finally {
    await srv.close();
  }
});

test("POST /v1/sessions/:id rejects malformed colors and non-boolean pins", async () => {
  const srv = start();
  try {
    const id = await newSession(srv.base, "web:U1:pin-color-bad");

    for (const color of ["red", "#fff", "#12345", "#gggggg", "url(x)", "#aabbcc;background:red", 42]) {
      const r = await patch(srv.base, id, { principalId: "U1", color });
      assert.equal(r.status, 400, `rejects ${JSON.stringify(color)}`);
    }
    const badPin = await patch(srv.base, id, { principalId: "U1", pinned: "yes" });
    assert.equal(badPin.status, 400);

    const empty = await patch(srv.base, id, { principalId: "U1" });
    assert.equal(empty.status, 400, "an empty patch is a bad request");

    const stranger = await patch(srv.base, id, { principalId: "intruder", pinned: true });
    assert.equal(stranger.status, 404, "a non-participant cannot touch the view");
  } finally {
    await srv.close();
  }
});
