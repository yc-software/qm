import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import "./support/auto-fake-sprites.ts";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { readMemory } from "../src/memory/memory-service.ts";
import { principalOf } from "./support/principal.ts";

const SECRET = "core-signing-secret".repeat(3);

const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "webui-mem-")) }));
const core = createServer(built.app, { signingSecret: SECRET, memory: built.memory });
core.listen(0);
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "";
const { handler } = await import("../plugins/web-ui/server/index.ts");
const web = createHttpServer(handler);
web.listen(0);
const webBase = `http://localhost:${(web.address() as AddressInfo).port}`;

after(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await new Promise<void>((r) => core.close(() => r()));
});

function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: `webuiuser=${encodeURIComponent(user)}`,
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
      ...init.headers,
    },
  };
}

test("a signed-in user reads, edits, and re-reads their own memory; identity is the cookie", async () => {
  const ALICE_ID = await principalOf(built, "alice");
  const BOB_ID = await principalOf(built, "bob");
  const empty = await fetch(`${webBase}/api/memory`, asUser(ALICE_ID));
  assert.equal(empty.status, 200);
  assert.equal(((await empty.json()) as { content: string }).content, "");

  const put = await fetch(
    `${webBase}/api/memory`,
    asUser(ALICE_ID, { method: "PUT", body: JSON.stringify({ content: "# Memory\n\n- Calls me Al\n" }) }),
  );
  assert.equal(put.status, 200);

  const back = await fetch(`${webBase}/api/memory`, asUser(ALICE_ID));
  assert.equal(((await back.json()) as { content: string }).content, "# Memory\n\n- Calls me Al\n");

  assert.equal(await readMemory(built.workspace, `personal:${ALICE_ID}`), "# Memory\n\n- Calls me Al\n");

  const bob = await fetch(`${webBase}/api/memory`, asUser(BOB_ID));
  assert.equal(((await bob.json()) as { content: string }).content, "", "another user's memory is separate");

  await fetch(
    `${webBase}/api/memory`,
    asUser(BOB_ID, { method: "PUT", body: JSON.stringify({ principalId: ALICE_ID, content: "bob was here" }) }),
  );
  assert.equal(
    await readMemory(built.workspace, `personal:${ALICE_ID}`),
    "# Memory\n\n- Calls me Al\n",
    "a spoofed body principalId cannot overwrite alice's memory",
  );
  assert.equal(
    await readMemory(built.workspace, `personal:${BOB_ID}`),
    "bob was here\n",
    "bob's write lands in bob's own scope",
  );
});

test("memory routes require a signed-in principal", async () => {
  assert.equal((await fetch(`${webBase}/api/memory`)).status, 401);
  assert.equal(
    (
      await fetch(`${webBase}/api/memory`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      })
    ).status,
    401,
  );
});

test("a non-string content is REJECTED, not coerced to a wipe; an empty string still clears", async () => {
  const CAROL_ID = await principalOf(built, "carol");
  await fetch(
    `${webBase}/api/memory`,
    asUser(CAROL_ID, { method: "PUT", body: JSON.stringify({ content: "# Memory\n\n- keep me\n" }) }),
  );
  const bad = await fetch(
    `${webBase}/api/memory`,
    asUser(CAROL_ID, { method: "PUT", body: JSON.stringify({ content: 42 }) }),
  );
  assert.equal(bad.status, 400, "non-string content is rejected");
  assert.equal(
    await readMemory(built.workspace, `personal:${CAROL_ID}`),
    "# Memory\n\n- keep me\n",
    "the malformed request did not wipe memory",
  );

  const clear = await fetch(
    `${webBase}/api/memory`,
    asUser(CAROL_ID, { method: "PUT", body: JSON.stringify({ content: "" }) }),
  );
  assert.equal(clear.status, 200);
  assert.equal(
    ((await (await fetch(`${webBase}/api/memory`, asUser(CAROL_ID))).json()) as { content: string }).content,
    "",
    "empty string clears the notebook",
  );
});
