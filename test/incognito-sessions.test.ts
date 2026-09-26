import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";

async function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "incognito-")) }));
  const server = createInsecureTestServer(built.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const turnBody = (threadRef: string, text: string, extra: Record<string, unknown> = {}) => ({
  surface: "web",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef },
  text,
  ...extra,
});

test("the first turn sets incognito; later turns inherit it and a conflicting value is a 409", async () => {
  const s = await start();
  const post = (path: string, body: unknown) =>
    fetch(`${s.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = async (path: string): Promise<any> => (await fetch(`${s.base}${path}`)).json();
  try {
    const secretRef = `web:U1:${randomUUID()}`;
    const normalRef = `web:U1:${randomUUID()}`;

    const first = await post("/v1/turns", turnBody(secretRef, "zebrafish tasting notes", { incognito: true }));
    assert.equal(first.status, 200);
    const created = (await first.json()) as any;
    assert.equal(created.incognito, true);
    const secretId = created.sessionId as string;

    const followUp = await post("/v1/turns", turnBody(secretRef, "more zebrafish notes"));
    assert.equal(followUp.status, 200);
    const inherited = (await followUp.json()) as any;
    assert.equal(inherited.sessionId, secretId);
    assert.equal(inherited.incognito, true);

    const conflict = await post("/v1/turns", turnBody(secretRef, "turn it off", { incognito: false }));
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as any).refusalKind, "incognito_conflict");

    const normal = await post("/v1/turns", turnBody(normalRef, "zebrafish aquarium plans", { incognito: false }));
    assert.equal(normal.status, 200);
    const normalResult = (await normal.json()) as any;
    assert.equal(normalResult.incognito, undefined);
    const normalId = normalResult.sessionId as string;
    const turnOn = await post("/v1/turns", turnBody(normalRef, "turn it on", { incognito: true }));
    assert.equal(turnOn.status, 409);

    assert.equal((await post("/v1/turns", turnBody(normalRef, "hm", { incognito: "yes" }))).status, 400);

    assert.equal((await get(`/v1/sessions/${secretId}?viewer=U1`)).session.incognito, true);
    assert.equal((await get(`/v1/sessions/${normalId}?viewer=U1`)).session.incognito, undefined);

    const listed = (await get("/v1/sessions?principalId=U1")).sessions.map((session: { id: string }) => session.id);
    assert.ok(listed.includes(normalId));
    assert.ok(!listed.includes(secretId));

    const hits = (await get("/v1/sessions/search?principalId=U1&q=zebrafish")).hits as Array<{ sessionId: string }>;
    assert.ok(hits.some((hit) => hit.sessionId === normalId));
    assert.ok(!hits.some((hit) => hit.sessionId === secretId));

    const queued = await post("/v1/turns?async=1", turnBody(`web:U1:${randomUUID()}`, "queued", { incognito: true }));
    assert.equal(queued.status, 202);
    const run = await get(`/v1/runs/${((await queued.json()) as any).runId}`);
    assert.equal(run.incognito, true);
    const normalRun = await post("/v1/turns?async=1", turnBody(normalRef, "queued normal"));
    assert.equal((await get(`/v1/runs/${((await normalRun.json()) as any).runId}`)).incognito, undefined);

    const fork = await s.built.app.forkSession(secretId, "U1");
    assert.equal(fork?.session.incognito, true, "a fork of an incognito session stays incognito");
    const normalFork = await s.built.app.forkSession(normalId, "U1");
    assert.equal(normalFork?.session.incognito, undefined);
  } finally {
    await s.close();
  }
});
