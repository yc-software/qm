import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, verifyCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "surface-context-test-secret".repeat(3);

describe("surface-context pulls", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = (overrides: Record<string, unknown> = {}) =>
    mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: scopeId("channel", "C9"),
        destination: { type: "slack", target: "C9:1700.0001", audienceScopeId: scopeId("channel", "C9") },
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...overrides,
      },
      SECRET,
    );

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  let pollSeq = 0;
  const pendingPath = () => `/v1/surface-context/pending?source=slack&t=${pollSeq++}`;
  const signedGet = (path: string) =>
    fetch(`${base}${path}`, { headers: signedRequestHeaders(SECRET, "GET", path, "") });
  const signedPost = (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signedRequestHeaders(SECRET, "POST", path, raw) },
      body: raw,
    });
  };

  const fulfillNext = async (answer: (q: any) => unknown): Promise<any> => {
    for (let i = 0; i < 100; i++) {
      const res = await signedGet(pendingPath());
      const { requests } = (await res.json()) as { requests: Array<{ id: string; query: any }> };
      if (requests.length) {
        const r = requests[0]!;
        const ok = await signedPost(`/v1/surface-context/${r.id}/result`, answer(r.query));
        assert.equal(ok.status, 200);
        return r.query;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("no pending context request appeared");
  };

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "surface-context-")),
        signingSecret: SECRET,
      }),
    );
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    await built.app.upsertDirectory([
      { principalId: "U1", displayName: "Una", type: "internal" },
      { principalId: "U-member", displayName: "Mia", type: "internal" },
    ]);
    await built.app.upsertChannels(
      [
        { channelId: "C9", name: "current" },
        { channelId: "C-ENG", name: "eng" },
        { channelId: "CPUBLIC01", name: "general" },
        { channelId: "C-SECRET", name: "warroom", isPrivate: true },
      ],
      [
        { channelId: "C9", principalId: "U1" },
        { channelId: "C9", principalId: "U-ghost" },
        { channelId: "C9", principalId: "U-member" },
        { channelId: "C-SECRET", principalId: "U-member" },
      ],
    );
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("answers a current-conversation pull with the plugin's messages, passing the token's opaque target", async () => {
    const asking = post("/v1/surface-context", { count: 5, match: "Deploy" }, { "x-agent-capability": await cap() });
    const query = await fulfillNext(() => ({
      messages: [{ ts: "1699.0001", author: "Alice", text: "deploy went out" }],
      hasMore: true,
      nextBefore: "1699.0001",
    }));
    assert.equal(
      query.conversationTarget,
      "C9:1700.0001",
      "the surface-authored target rides through, never agent-authored",
    );
    assert.equal(query.count, 5);
    assert.equal(query.match, "Deploy");
    const res = await asking;
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.messages[0].text, "deploy went out");
    assert.equal(body.hasMore, true);
    assert.equal(body.nextBefore, "1699.0001");
    const pending = await (await signedGet(pendingPath())).json();
    assert.deepEqual((pending as any).requests, []);
  });

  it("resolves a public channel by name through the directory", async () => {
    const asking = post("/v1/surface-context", { channel: "#eng" }, { "x-agent-capability": await cap() });
    const query = await fulfillNext(() => ({ messages: [] }));
    assert.equal(query.channelId, "C-ENG");
    assert.equal(query.channelName, "eng");
    assert.equal(query.count, 100, "default count");
    const res = await asking;
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).channel, "#eng");
  });

  it("passes a raw channel id straight to the plugin (a public channel the actor can see), skipping the (possibly stale) directory", async () => {
    const asking = post("/v1/surface-context", { channel: "CPUBLIC01" }, { "x-agent-capability": await cap() });
    const query = await fulfillNext(() => ({ messages: [] }));
    assert.equal(query.channelId, "CPUBLIC01");
    assert.equal(query.channelName, undefined, "no name claimed — the plugin verifies the id surface-side");
    assert.equal((await asking).status, 200);
  });

  it("refuses a raw channel id the actor can't be confirmed to see (fail-closed)", async () => {
    const res = await post("/v1/surface-context", { channel: "C0RAWID99" }, { "x-agent-capability": await cap() });
    assert.equal(res.status, 403, "an unverifiable raw id fails closed rather than dumping unknown history");
    const pending = await (await signedGet(pendingPath())).json();
    assert.deepEqual((pending as any).requests, [], "nothing was parked");
  });

  it("relays a plugin-side failure as 502", async () => {
    const asking = post("/v1/surface-context", { channel: "eng" }, { "x-agent-capability": await cap() });
    await fulfillNext(() => ({ error: "I'm not a member of that channel" }));
    const res = await asking;
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as any).message, /not a member/);
  });

  it("refuses a private channel the asking actor isn't a member of — never parks it", async () => {
    const res = await post("/v1/surface-context", { channel: "warroom" }, { "x-agent-capability": await cap() });
    assert.equal(res.status, 403, "a non-member can't read a private channel's history");
    assert.equal(((await res.json()) as any).error, "not_visible");
    const pending = await (await signedGet(pendingPath())).json();
    assert.deepEqual((pending as any).requests, [], "nothing was parked for the surface to read");
  });

  it("tells an actor not in the directory to link Slack, rather than implying exclusion", async () => {
    const res = await post(
      "/v1/surface-context",
      { channel: "warroom" },
      { "x-agent-capability": await cap({ actorId: "U-ghost" }) },
    );
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).error, "identity_unverified");
  });

  it("reads a private channel for an actor who IS a member", async () => {
    const asking = post(
      "/v1/surface-context",
      { channel: "warroom" },
      { "x-agent-capability": await cap({ actorId: "U-member" }) },
    );
    const query = await fulfillNext(() => ({ messages: [{ ts: "1699.9", author: "Bob", text: "in the warroom" }] }));
    assert.equal(query.channelId, "C-SECRET");
    assert.equal(query.channelName, "warroom");
    const res = await asking;
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).messages[0].text, "in the warroom");
  });

  it("refuses a raw private-channel id the asking actor isn't a member of", async () => {
    const res = await post("/v1/surface-context", { channel: "C-SECRET" }, { "x-agent-capability": await cap() });
    assert.equal(res.status, 403, "the raw-id branch is gated on the asker's visibility too");
    assert.equal(((await res.json()) as any).error, "not_visible");
  });

  it("reads a raw private-channel id for an actor who IS a member", async () => {
    const asking = post(
      "/v1/surface-context",
      { channel: "C-SECRET" },
      { "x-agent-capability": await cap({ actorId: "U-member" }) },
    );
    const query = await fulfillNext(() => ({ messages: [] }));
    assert.equal(query.channelId, "C-SECRET");
    assert.equal((await asking).status, 200);
  });

  it("refuses an unknown channel and a token with no slack destination", async () => {
    const unknown = await post("/v1/surface-context", { channel: "nope" }, { "x-agent-capability": await cap() });
    assert.equal(unknown.status, 404);

    const noDest = await post(
      "/v1/surface-context",
      {},
      { "x-agent-capability": await cap({ destination: undefined }) },
    );
    assert.equal(noDest.status, 400);
    assert.equal(((await noDest.json()) as any).error, "no_conversation");
  });

  it("requires auth: no capability and no source signature → rejected", async () => {
    const res = await post("/v1/surface-context", { channel: "eng" });
    assert.notEqual(res.status, 200);
    const pending = await signedGet(pendingPath());
    assert.deepEqual(((await pending.json()) as any).requests, [], "nothing was parked");
  });

  it("hanging pending-poll returns the moment a request is parked, not after a poll tick", async () => {
    const t0 = Date.now();
    const hanging = signedGet(`/v1/surface-context/pending?source=slack&waitMs=10000&t=${pollSeq++}`);
    setTimeout(async () => {
      void post("/v1/surface-context", { count: 1 }, { "x-agent-capability": await cap() });
    }, 300);
    const { requests } = (await (await hanging).json()) as { requests: Array<{ id: string }> };
    const elapsed = Date.now() - t0;
    assert.equal(requests.length, 1, "the hanging poll surfaced the parked request");
    assert.ok(
      elapsed < 5000,
      `returned in ${elapsed}ms — should be shortly after the request landed, not at the wait cap`,
    );
    await signedPost(`/v1/surface-context/${requests[0]!.id}/result`, { messages: [] });
  });

  it("404s a result for an expired/unknown request id", async () => {
    const res = await signedPost("/v1/surface-context/nonexistent/result", { messages: [] });
    assert.equal(res.status, 404);
  });

  it("answers a file pull with metadata plus a download token pinned to exactly that blob", async () => {
    const asking = post(
      "/v1/surface-file",
      { channel: "#eng", ts: "1699.5", name: "wave.png" },
      {
        "x-agent-capability": await cap({
          botActor: true,
          liveActor: true,
          members: [{ id: "U1", type: "internal" }],
        }),
      },
    );
    const query = await fulfillNext(() => ({
      file: { blobId: "blob-42", name: "wave.png", sizeBytes: 3, mimetype: "image/png", author: "Alice" },
    }));
    assert.equal(query.channelId, "C-ENG");
    assert.deepEqual(query.file, { ts: "1699.5", name: "wave.png" });
    const res = await asking;
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.deepEqual(body.file, { name: "wave.png", sizeBytes: 3, mimetype: "image/png", author: "Alice" });
    assert.equal(body.download.path, "/v1/blobs/blob-42");
    assert.equal(body.download.header, "x-agent-capability");
    const token = await verifyCapabilityToken(body.download.token, SECRET);
    assert.ok(token, "the download token verifies against the core secret");
    assert.equal(token!.aud, "blob-transfer");
    assert.deepEqual(token!.blob, { dir: "read", id: "blob-42" }, "the token moves this one blob, read-only");
    assert.equal(token!.botActor, true);
    assert.equal(token!.liveActor, true);
    assert.deepEqual(token!.members, [{ id: "U1", type: "internal" }]);
  });

  it("a current-conversation file pull rides the token's opaque target and passes threadTs through", async () => {
    const asking = post(
      "/v1/surface-file",
      { ts: "1700.2", threadTs: "1700.0001" },
      { "x-agent-capability": await cap() },
    );
    const query = await fulfillNext(() => ({ file: { blobId: "b2", name: "notes.txt", sizeBytes: 9 } }));
    assert.equal(query.conversationTarget, "C9:1700.0001");
    assert.deepEqual(query.file, { ts: "1700.2", threadTs: "1700.0001" });
    assert.equal((await asking).status, 200);
  });

  it("gates a file pull on the ASKER's visibility — a private channel's file is refused to a non-member, served to a member", async () => {
    const refused = await post(
      "/v1/surface-file",
      { channel: "warroom", ts: "1.0" },
      { "x-agent-capability": await cap() },
    );
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as any).error, "not_visible");
    assert.deepEqual(((await (await signedGet(pendingPath())).json()) as any).requests, [], "nothing was parked");

    const asking = post(
      "/v1/surface-file",
      { channel: "warroom", ts: "1.0" },
      { "x-agent-capability": await cap({ actorId: "U-member" }) },
    );
    const query = await fulfillNext(() => ({ file: { blobId: "b3", name: "secret.pdf", sizeBytes: 1 } }));
    assert.equal(query.channelId, "C-SECRET");
    assert.equal((await asking).status, 200);
  });

  it("rejects a file pull without ts, and relays a plugin-side failure as 502", async () => {
    const noTs = await post("/v1/surface-file", { channel: "#eng" }, { "x-agent-capability": await cap() });
    assert.equal(noTs.status, 400);

    const asking = post("/v1/surface-file", { channel: "#eng", ts: "9.9" }, { "x-agent-capability": await cap() });
    await fulfillNext(() => ({ error: "that message has no files attached" }));
    const res = await asking;
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as any).message, /no files/);
  });

  it("a done answer that carries no file is a surface error, not a success", async () => {
    const asking = post("/v1/surface-file", { channel: "#eng", ts: "9.9" }, { "x-agent-capability": await cap() });
    await fulfillNext(() => ({ messages: [] }));
    assert.equal((await asking).status, 502);
  });

  it("keeps the viewer's search token out of the durable row but hands it to the fulfiller, and drops it on fulfill", async () => {
    const r = await built.app.createContextRequest("slack", {
      conversationTarget: "C9:1.1",
      count: 10,
      viewer: "U1",
      searchAll: "hubble",
      viewerToken: "xoxp-secret",
    });
    const stored = await built.app.getContextRequest(r.id);
    assert.equal((stored as any)?.query?.viewerToken, undefined, "the stored row never carries the token");
    const pending = await built.app.pendingContextRequests("slack");
    const mine = pending.find((p) => p.id === r.id);
    assert.equal((mine?.query as any)?.viewerToken, "xoxp-secret", "the fulfiller-facing view re-attaches it");
    await built.app.fulfillContextRequest(r.id, { result: { messages: [] } });
    const done = await built.app.getContextRequest(r.id);
    assert.equal((done as any)?.query?.viewerToken, undefined, "a fulfilled row still carries no token");
    await built.app.deleteContextRequest(r.id);
  });
});
