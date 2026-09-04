import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import {
  createBrowserSessionStore,
  type BrowserSessionStore,
  type StoredBrowserSession,
} from "../src/connectors/browser-session-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";

const SECRET = "emoji-route-secret".repeat(3);
const ACTOR = "U_E1";
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString("base64");

describe("POST /v1/emoji", async () => {
  let server: Server;
  let bare: Server;
  let base: string;
  let bareBase: string;
  let built: BuiltApp;
  let sessions: BrowserSessionStore;

  const capFor = (actorId: string, scope = scopeId("personal", actorId)) =>
    mintCapabilityToken(
      { actorId, scopeId: scope, aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );

  before(async () => {
    built = buildApp(testConfig({ signingSecret: SECRET }));
    sessions = createBrowserSessionStore({
      sessions: createMemoryMap<StoredBrowserSession>(),
      key: deriveConnectorKey(Buffer.alloc(32, 1)),
    });
    await sessions.put(ACTOR, JSON.stringify({ cookies: [] }));
    const directory = createDirectoryStore();
    await directory.setWorkspaceUrl("https://acme.slack.com/");
    server = createServer(built.app, {
      signingSecret: SECRET,
      browserSessionStore: sessions,
      directory,
      config: built.config,
    });
    bare = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((r) => server.listen(0, r));
    await new Promise<void>((r) => bare.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    bareBase = `http://localhost:${(bare.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => bare.close(() => r()));
  });

  const post = (b: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${b}/v1/emoji`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("401 without a capability token", async () => {
    assert.equal((await post(base, { name: "x", image: PNG_B64 })).status, 401);
    assert.equal((await post(base, { name: "x", image: PNG_B64 }, { "x-agent-capability": "garbage" })).status, 401);
  });

  it("404 not_supported when no session store is wired", async () => {
    const res = await post(bareBase, { name: "x", image: PNG_B64 }, { "x-agent-capability": await capFor(ACTOR) });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as any).error, "not_supported");
  });

  it("400 bad_request when name or image is missing", async () => {
    assert.equal((await post(base, { name: "x" }, { "x-agent-capability": await capFor(ACTOR) })).status, 400);
    assert.equal((await post(base, { image: PNG_B64 }, { "x-agent-capability": await capFor(ACTOR) })).status, 400);
  });

  it("422 {ok:false} with a clear error on an invalid name (a real result, not a crash)", async () => {
    const res = await post(base, { name: "Bad Name", image: PNG_B64 }, { "x-agent-capability": await capFor(ACTOR) });
    assert.equal(res.status, 422);
    const got = (await res.json()) as any;
    assert.equal(got.ok, false);
    assert.match(got.error, /isn't a valid emoji name/);
  });

  it("422 {ok:false} session-expired when the stored session can't authenticate", async () => {
    const res = await post(
      base,
      { name: "partyparrot", image: PNG_B64 },
      { "x-agent-capability": await capFor(ACTOR) },
    );
    assert.equal(res.status, 422);
    const got = (await res.json()) as any;
    assert.equal(got.ok, false);
    assert.match(got.error, /session .* has expired/i);
  });
});
