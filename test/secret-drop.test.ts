import "./support/auto-fake-sprites.ts";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { createSecretDropStore, SECRET_DROP_TTL_MS } from "../src/credentials/secret-drop.ts";
import { fireDropResolution, type DropResolution } from "../src/triggers/keychain-ask.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import {
  mintCapabilityToken,
  verifyCapabilityToken,
  CAPABILITY_TTL_MS,
  SECRET_DROP_AUD,
  type CapabilityClaims,
} from "../src/auth/capability-token.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "secret-drop-test-secret".repeat(3);

describe("SecretDropStore", () => {
  it("mint → peek (non-consuming) → redeem (single-use)", async () => {
    const t = 1_000_000;
    const store = createSecretDropStore(createMemoryMap(), { now: () => t });
    const { dropId } = await store.mint({
      ownerId: "U_A",
      service: "stripe",
      purpose: "charge cards",
      requestedBy: "U_A",
    });

    const p1 = await store.peek(dropId);
    assert.ok(p1.ok && p1.rec.service === "stripe");
    assert.ok((await store.peek(dropId)).ok, "peek does not consume the drop");

    const r1 = await store.redeem(dropId);
    assert.ok(r1.ok && r1.rec.ownerId === "U_A");
    const r2 = await store.redeem(dropId);
    assert.ok(!r2.ok && r2.reason === "not_found", "single-use: a second redeem finds nothing");
    assert.ok(!(await store.peek(dropId)).ok, "the record is gone after redemption");
  });

  it("expires after the TTL, on both peek and redeem", async () => {
    let t = 1_000_000;
    const store = createSecretDropStore(createMemoryMap(), { now: () => t });
    const { dropId } = await store.mint({ ownerId: "U_A", service: "x", purpose: "p", requestedBy: "U_A" });
    t += SECRET_DROP_TTL_MS + 1;
    assert.deepEqual(await store.peek(dropId), { ok: false, reason: "expired" });
    assert.deepEqual(await store.redeem(dropId), { ok: false, reason: "expired" });
  });

  it("siblings: pending drops for the same conversation only — other threads, expired links, and same-service twins excluded", async () => {
    let t = 1_000_000;
    const store = createSecretDropStore(createMemoryMap(), { now: () => t });
    const base = {
      ownerId: "U_A",
      purpose: "p",
      requestedBy: "U_A",
      audienceScopeId: scopeId("channel", "C1"),
      threadRef: "t1",
    } as const;
    const { dropId: stale } = await store.mint({ ...base, service: "stale" });
    t += SECRET_DROP_TTL_MS + 1;
    const { dropId: a } = await store.mint({ ...base, service: "alphasvc" });
    await store.mint({ ...base, service: "alphasvc" });
    await store.mint({ ...base, service: "betasvc" });
    await store.mint({ ...base, service: "otherthread", threadRef: "t2" });
    await store.mint({ ...base, service: "otherscope", audienceScopeId: scopeId("channel", "C2") });

    const redeemed = await store.redeem(a);
    assert.ok(redeemed.ok);
    assert.deepEqual(
      (await store.siblings(redeemed.rec)).map((r) => r.service).sort(),
      ["betasvc"],
      "same scope + thread, unexpired, different service",
    );
    assert.ok(!(await store.peek(stale)).ok, "the scan reaps expired links it walks past");
  });
});

describe("fireDropResolution", () => {
  const depsWith = (run: (req: TurnRequest) => Promise<TurnResult>) => ({
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(createMemoryMap<IdempotencyRecord>()),
    identity: createIdentityService(createMemoryMap()),
    run,
  });

  it("resumes the channel as the owner with the grant use command, exactly once", async () => {
    const seen: TurnRequest[] = [];
    const deps = depsWith(async (req) => {
      seen.push(req);
      return { status: "ok" } as TurnResult;
    });
    const drop: DropResolution = {
      id: "drop1",
      ownerId: "U_A",
      service: "stripe",
      purpose: "charge cards",
      audienceScopeId: scopeId("channel", "C1"),
      threadRef: "ch:C1-t",
      destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
      grantId: "g1",
      granted: true,
    };
    await fireDropResolution(deps, drop);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.conversation.kind, "channel");
    assert.equal(seen[0]!.actor.externalId, "U_A", "the resume runs as the owner who supplied the key");
    assert.match(seen[0]!.text, /g1/, "the channel resume hands over the grant's use command");

    await fireDropResolution(deps, drop);
    assert.equal(seen.length, 1, "the drop:<id> fireKey dedupes a double fire");
  });

  it("resumes a DM (own scope, no grant) and tells the agent the key is available here", async () => {
    const seen: TurnRequest[] = [];
    const deps = depsWith(async (req) => {
      seen.push(req);
      return { status: "ok" } as TurnResult;
    });
    await fireDropResolution(deps, {
      id: "drop2",
      ownerId: "U_A",
      service: "openai",
      purpose: "summarize",
      audienceScopeId: scopeId("personal", "U_A"),
      granted: false,
    });
    assert.equal(seen[0]!.conversation.kind, "dm");
    assert.match(seen[0]!.text, /available here/);
  });

  it("enqueues a fallback delivery when the resume turn doesn't land (drop is single-use, no sweep)", async () => {
    const deliveries = createDeliveryStore();
    const deps = {
      deliveries,
      idempotency: createIdempotencyStore(createMemoryMap<IdempotencyRecord>()),
      identity: createIdentityService(createMemoryMap()),
      run: async () => ({ status: "pending_approval" }) as TurnResult,
    };
    const destination = { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") } as const;
    await fireDropResolution(deps, {
      id: "dropF",
      ownerId: "U_A",
      service: "stripe",
      purpose: "p",
      audienceScopeId: scopeId("channel", "C1"),
      destination,
      grantId: "g1",
      granted: true,
    });
    const fb = (await deliveries.pending("slack")).filter((d) => d.idempotencyKey === "drop:dropF:fallback");
    assert.equal(fb.length, 1, "the conversation hears the key arrived even when the resume turn didn't run");
    assert.match(fb[0]!.text, /saved to the keychain/);
  });

  it("with sibling drops still pending: the wake fires (with its grant) but says what's outstanding instead of ordering a resume", async () => {
    const seen: TurnRequest[] = [];
    const deps = depsWith(async (req) => {
      seen.push(req);
      return { status: "ok" } as TurnResult;
    });
    await fireDropResolution(deps, {
      id: "dropP",
      ownerId: "U_A",
      service: "alphasvc",
      purpose: "p",
      audienceScopeId: scopeId("channel", "C1"),
      destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
      grantId: "gA",
      granted: true,
      pendingSiblings: ["betasvc"],
    });
    assert.equal(seen.length, 1, "every redeem wakes the conversation — it must hear each grant's load command");
    assert.match(seen[0]!.text, /gA/, "the intermediate wake still hands over its own grant");
    assert.match(seen[0]!.text, /`betasvc`.*haven't been filled/, "the wake names the outstanding sibling links");
    assert.match(seen[0]!.text, /keep waiting/);
    assert.doesNotMatch(seen[0]!.text, /Pick the task back up/, "no resume order while credentials are outstanding");
    assert.doesNotMatch(seen[0]!.text, /and run the task/, "the grant load command must not carry a run order either");
  });
});

describe("/v1/keychain/drops — mint, form, redeem", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
    mintCapabilityToken({ actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS, ...extra }, SECRET);
  const post = (path: string, body: unknown, cap?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cap ? { "x-agent-capability": cap } : {}) },
      body: JSON.stringify(body),
    });
  let nonce = 0;
  const signed = (method: string, rawPath: string, body: string, owner?: string | null) => {
    const path = `${rawPath}${rawPath.includes("?") ? "&" : "?"}_n=${nonce++}`;
    const headers: Record<string, string> = {
      ...signedRequestHeaders(SECRET, method, path, body),
      ...(owner !== null ? { "x-drop-owner": owner ?? "U_A", "x-drop-owner-org": "acme" } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    };
    return fetch(`${base}${path}`, { method, headers, ...(body ? { body } : {}) });
  };
  const getForm = (dropId: string, owner?: string | null, token?: string | null) =>
    signed("GET", `/v1/keychain/drops/${dropId}/form${token ? `?t=${encodeURIComponent(token)}` : ""}`, "", owner);
  const redeem = (dropId: string, body: unknown, owner?: string | null, token?: string | null) =>
    signed(
      "POST",
      `/v1/keychain/drops/${encodeURIComponent(dropId)}${token ? `?t=${encodeURIComponent(token)}` : ""}`,
      JSON.stringify(body),
      owner,
    );
  const linkToken = (formPath: string) => new URL(formPath, "http://x").searchParams.get("t");

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "secret-drop-")), signingSecret: SECRET }));
    await built.directory.replaceChannels(
      [{ channelId: "C1", name: "drops", isPrivate: false }],
      [{ channelId: "C1", principalId: "U_A" }],
    );
    server = createServer(built.app, {
      signingSecret: SECRET,
      keychain: built.keychain,
      secretDrops: built.secretDrops,
      deliveries: built.deliveries,
      workspace: built.workspace,
      auditLog: built.auditLog,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a triggered turn cannot mint a drop", async () => {
    const res = await post(
      "/v1/keychain/drops",
      { service: "stripe", purpose: "p" },
      await capFor("U_A", scopeId("channel", "C1"), { triggered: true }),
    );
    assert.equal(res.status, 403);
  });

  it("channel mint → redeem saves the credential AND grants it to the asking conversation", async () => {
    const minted = await post(
      "/v1/keychain/drops",
      { service: "stripe", purpose: "charge the test card", envKey: "STRIPE_API_KEY" },
      await capFor("U_A", scopeId("channel", "C1")),
    );
    assert.equal(minted.status, 200);
    const { dropId, formPath } = (await minted.json()) as { dropId: string; formPath: string };
    assert.ok(formPath.startsWith(`/drop/${dropId}/form?t=`), "the link carries its drop-scoped token");
    const t = linkToken(formPath);

    const form = await getForm(dropId, "U_A", t);
    assert.equal(form.status, 200);
    assert.match(form.headers.get("content-type") ?? "", /text\/html/);
    const html = await form.text();
    assert.match(html, /stripe/);
    assert.match(html, /charge the test card/);
    assert.match(html, /['"]\/drop\/['"]/);
    assert.doesNotMatch(html, /\/v1\/keychain\/drops\//);

    assert.equal((await getForm(dropId, "U_someone_else", t)).status, 403);
    assert.equal((await redeem(dropId, { secret: "sk_evil" }, "U_someone_else", t)).status, 403);
    assert.equal((await getForm(dropId, null, t)).status, 403);
    assert.equal((await getForm(dropId, "U_A", t)).status, 200, "the rejected attempts left the link usable");

    const redeemRes = await redeem(dropId, { secret: "sk_test_alice" }, "U_A", t);
    assert.equal(redeemRes.status, 200);
    const { credential } = (await redeemRes.json()) as { credential: { id: string; service: string; ownerId: string } };
    assert.equal(credential.service, "stripe");
    assert.equal(credential.ownerId, "U_A");

    const grants = await built.keychain!.grantsForScope(scopeId("channel", "C1"));
    const g = grants.find((x) => x.credential.id === credential.id);
    assert.ok(g, "a standing grant for the asking channel was minted on redeem");
    const m = await built.keychain!.materialize(g!.grant.id, scopeId("channel", "C1"), "U_A");
    assert.ok(m.kind === "env" && m.env[0]!.value === "sk_test_alice");

    assert.equal((await redeem(dropId, { secret: "sk_test_again" }, "U_A", t)).status, 404);
    assert.equal((await getForm(dropId, "U_A", t)).status, 404, "the form 404s once the drop is redeemed");
  });

  it("DM mint → redeem saves the credential under the owner with NO grant (own scope)", async () => {
    const minted = await post(
      "/v1/keychain/drops",
      { service: "openai", purpose: "summarize my notes" },
      await capFor("U_B"),
    );
    const { dropId, formPath } = (await minted.json()) as { dropId: string; formPath: string };
    const redeemRes = await redeem(dropId, { secret: "sk-openai-bob" }, "U_B", linkToken(formPath));
    assert.equal(redeemRes.status, 200);

    const owned = await built.keychain!.listByOwner("U_B");
    assert.ok(
      owned.some((c) => c.service === "openai"),
      "the credential landed in the owner's keychain",
    );
    assert.equal(
      (await built.keychain!.listGrants({ ownerId: "U_B" })).length,
      0,
      "a DM drop grants nothing — own creds need no grant",
    );
  });

  it("a Project roster change invalidates an unredeemed drop", async () => {
    await built.app.upsertDirectory([
      { principalId: "U_PROJECT_OWNER", displayName: "Owner", type: "internal" },
      { principalId: "U_PROJECT_MEMBER", displayName: "Member", type: "internal" },
    ]);
    const project = await built.app.createProject("U_PROJECT_OWNER", "Drop fence");
    assert.ok(project);
    const scopeVersion = await built.projects.version(project.scopeId.slice("group:".length));
    assert.ok(scopeVersion);
    const cap = await capFor("U_PROJECT_OWNER", project.scopeId, { scopeVersion });
    const minted = await post("/v1/keychain/drops", { service: "project-stale", purpose: "test the fence" }, cap);
    assert.equal(minted.status, 200);
    const { dropId, formPath } = (await minted.json()) as { dropId: string; formPath: string };

    assert.equal((await built.app.addProjectMember(project.id, "U_PROJECT_OWNER", "U_PROJECT_MEMBER")).status, "ok");
    assert.equal(
      (await redeem(dropId, { secret: "must-not-save" }, "U_PROJECT_OWNER", linkToken(formPath))).status,
      409,
    );
    assert.ok(
      !(await built.keychain!.listByOwner("U_PROJECT_OWNER")).some(
        (credential) => credential.service === "project-stale",
      ),
    );
  });

  it("an agent-declared fields[] drop renders each input, saves them all, and materializes them in order", async () => {
    const fields = [
      { key: "DOORDASH_EMAIL", label: "Email", secret: false },
      { key: "DOORDASH_PASSWORD", label: "Password" },
    ];
    const minted = await post(
      "/v1/keychain/drops",
      { service: "doordash", purpose: "place a pickup order", fields },
      await capFor("U_A", scopeId("channel", "C1")),
    );
    assert.equal(minted.status, 200);
    const { dropId, formPath } = (await minted.json()) as { dropId: string; formPath: string };
    const t = linkToken(formPath);

    const html = await (await getForm(dropId, "U_A", t)).text();
    assert.match(html, /placeholder="Email"/, "the form renders the declared labels");
    assert.match(html, /placeholder="Password"/);
    assert.match(html, /type=text[^>]*placeholder="Email"/, "a non-secret field is a visible input");

    assert.equal((await redeem(dropId, { values: { DOORDASH_EMAIL: "alice@acme.co" } }, "U_A", t)).status, 400);
    assert.equal((await getForm(dropId, "U_A", t)).status, 200, "a rejected submit leaves the link usable");

    const redeemRes = await redeem(
      dropId,
      { values: { DOORDASH_EMAIL: "alice@acme.co", DOORDASH_PASSWORD: "hunter2" } },
      "U_A",
      t,
    );
    assert.equal(redeemRes.status, 200);
    const { credential } = (await redeemRes.json()) as {
      credential: { id: string; fields?: Array<{ envKey: string; secret: boolean }> };
    };
    assert.deepEqual(credential.fields, [
      { envKey: "DOORDASH_EMAIL", secret: false },
      { envKey: "DOORDASH_PASSWORD", secret: true },
    ]);

    const grants = await built.keychain!.grantsForScope(scopeId("channel", "C1"));
    const g = grants.find((x) => x.credential.id === credential.id);
    const m = await built.keychain!.materialize(g!.grant.id, scopeId("channel", "C1"), "U_A");
    assert.ok(m.kind === "env");
    assert.deepEqual(m.kind === "env" ? m.env : [], [
      { key: "DOORDASH_EMAIL", value: "alice@acme.co" },
      { key: "DOORDASH_PASSWORD", value: "hunter2" },
    ]);
  });

  it("rejects a malformed fields[] at mint", async () => {
    const bad = await post(
      "/v1/keychain/drops",
      { service: "x", purpose: "p", fields: [{ key: "not a valid env key" }] },
      await capFor("U_A", scopeId("channel", "C1")),
    );
    assert.equal(bad.status, 400);
  });

  it("redeem rejects a missing secret and an unknown link", async () => {
    const minted = await post(
      "/v1/keychain/drops",
      { service: "x", purpose: "p" },
      await capFor("U_A", scopeId("channel", "C1")),
    );
    const { dropId, formPath } = (await minted.json()) as { dropId: string; formPath: string };
    assert.equal((await redeem(dropId, {}, "U_A", linkToken(formPath))).status, 400, "no secret → 400");
    assert.equal(
      (await redeem("deadbeef", { secret: "x" }, "U_A", linkToken(formPath))).status,
      404,
      "unknown link → 404",
    );
  });

  const mintFor = async (owner: string, service = "tokensvc") => {
    const r = await post(
      "/v1/keychain/drops",
      { service, purpose: "token contract" },
      await capFor(owner, scopeId("channel", "C1")),
    );
    assert.equal(r.status, 200);
    const { dropId, formPath } = (await r.json()) as { dropId: string; formPath: string };
    return { dropId, t: linkToken(formPath)! };
  };

  it("the minted link's token is drop-scoped: our signature, the secret-drop audience, pinned to this drop and its owner, expiring with the record", async () => {
    const before = Date.now();
    const { dropId, t } = await mintFor("U_A");
    const claims = await verifyCapabilityToken(t, SECRET);
    assert.ok(claims, "the link token verifies against the capability secret");
    assert.equal(claims!.aud, SECRET_DROP_AUD);
    assert.equal(claims!.drop, dropId, "pinned to exactly this drop");
    assert.equal(claims!.actorId, "U_A", "pinned to the drop's owner");
    assert.ok(
      claims!.exp >= before + SECRET_DROP_TTL_MS && claims!.exp <= Date.now() + SECRET_DROP_TTL_MS,
      "the token lives exactly as long as the record",
    );
  });

  it("both legs refuse a missing, tampered, cross-drop, or wrong-audience token — without burning the link", async () => {
    const a = await mintFor("U_A", "alphatoken");
    const b = await mintFor("U_A", "betatoken");
    const tampered = a.t.slice(0, -4) + (a.t.endsWith("AAAA") ? "BBBB" : "AAAA");
    const controlPlane = await capFor("U_A", scopeId("channel", "C1"));

    assert.equal((await getForm(a.dropId, "U_A")).status, 404, "no token → 404");
    assert.equal((await getForm(a.dropId, "U_A", b.t)).status, 404, "another drop's token → 404");
    assert.equal((await getForm(a.dropId, "U_A", tampered)).status, 404, "tampered token → 404");
    assert.equal((await getForm(a.dropId, "U_A", controlPlane)).status, 404, "control-plane token → 404");

    const probe = await redeem(a.dropId, { secret: "x" }, "U_A");
    assert.equal(probe.status, 404, "no token → the spent-link 404, not a live-link tell");
    assert.match(
      ((await probe.json()) as { message: string }).message,
      /invalid or was already used/,
      "indistinguishable from a spent link",
    );
    assert.equal((await redeem(a.dropId, { secret: "x" }, "U_A", b.t)).status, 404, "another drop's token → 404");
    assert.equal((await redeem(a.dropId, { secret: "x" }, "U_A", tampered)).status, 404, "tampered token → 404");
    assert.equal(
      (await redeem(a.dropId, { secret: "x" }, "U_A", controlPlane)).status,
      404,
      "control-plane token → 404",
    );

    assert.equal((await getForm(a.dropId, "U_A", a.t)).status, 200, "the probes left the link usable");
    assert.equal((await redeem(a.dropId, { secret: "sk-alpha" }, "U_A", a.t)).status, 200);
  });

  it("an expired link token is refused even while the record lives", async () => {
    const { dropId } = await mintFor("U_A", "expiredtoken");
    const stale = await mintCapabilityToken(
      {
        actorId: "U_A",
        scopeId: scopeId("channel", "C1"),
        aud: SECRET_DROP_AUD,
        drop: dropId,
        exp: Date.now() - 1_000,
      },
      SECRET,
    );
    assert.equal((await getForm(dropId, "U_A", stale)).status, 404);
    assert.equal((await redeem(dropId, { secret: "x" }, "U_A", stale)).status, 404);
  });

  it("a valid token never overrides the owner gate: possession is still not authority", async () => {
    const { dropId, t } = await mintFor("U_A", "possession");
    assert.equal(
      (await getForm(dropId, "U_thief", t)).status,
      403,
      "someone else signed in, holding the whole link → not yours",
    );
    assert.equal((await redeem(dropId, { secret: "x" }, "U_thief", t)).status, 403);
    assert.equal((await redeem(dropId, { secret: "x" }, null, t)).status, 403, "no verified owner at all → refused");
  });

  it("a pre-token record (minted before links carried tokens) still works under the owner gate alone", async () => {
    const { dropId } = await built.secretDrops!.mint({
      ownerId: "U_LEGACY",
      service: "legacysvc",
      purpose: "old link",
      requestedBy: "U_LEGACY",
    });
    assert.equal((await getForm(dropId, "U_LEGACY")).status, 200, "no requiresToken flag → the token is not demanded");
    assert.equal((await redeem(dropId, { secret: "sk-legacy" }, "U_LEGACY")).status, 200);
  });

  it("the paste form re-presents the link's query string on submit, so the redeem leg sees the same token", async () => {
    const { dropId, t } = await mintFor("U_A", "formcarry");
    const html = await (await getForm(dropId, "U_A", t)).text();
    assert.match(html, /location\.search/, "the submit fetch carries location.search");
    assert.ok(!html.includes(t), "the token itself is never embedded in the page body");
  });

  it("a live bot attestation survives mint and private-scope redemption", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C1", name: "drops", isPrivate: true }],
      [{ channelId: "C1", principalId: "U_A" }],
    );
    const members = [{ id: "B-LEGACY", type: "internal" as const }];
    const minted = await post(
      "/v1/keychain/drops",
      { service: "botsvc", purpose: "bot credential" },
      await capFor("B-LEGACY", scopeId("channel", "C1"), {
        botActor: true,
        liveActor: true,
        members,
      }),
    );
    assert.equal(minted.status, 200);
    const { dropId, formPath } = (await minted.json()) as { dropId: string; formPath: string };
    const token = await verifyCapabilityToken(linkToken(formPath)!, SECRET);
    assert.equal(token?.botActor, true);
    assert.equal(token?.liveActor, true);
    assert.deepEqual(token?.members, members);
    assert.equal((await redeem(dropId, { secret: "bot-secret" }, "B-LEGACY", linkToken(formPath))).status, 200);
  });
});

describe("/v1/keychain/drops — sibling-aware resume", () => {
  it("first redeem reports its pending sibling; the last redeem fires clean", async () => {
    const built = buildApp(
      testConfig({ dataDir: mkdtempSync(join(tmpdir(), "secret-drop-sib-")), signingSecret: SECRET }),
    );
    await built.directory.replaceChannels(
      [{ channelId: "C1", name: "drops", isPrivate: false }],
      [{ channelId: "C1", principalId: "U_A" }],
    );
    const fires: DropResolution[] = [];
    let fired: (() => void) | undefined;
    const server = createServer(built.app, {
      signingSecret: SECRET,
      keychain: built.keychain,
      secretDrops: built.secretDrops,
      deliveries: built.deliveries,
      workspace: built.workspace,
      auditLog: built.auditLog,
      fireDropResolution: async (drop) => {
        fires.push(drop);
        fired?.();
      },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      const cap = await mintCapabilityToken(
        { actorId: "U_A", scopeId: scopeId("channel", "C1"), threadRef: "th1", exp: Date.now() + CAPABILITY_TTL_MS },
        SECRET,
      );
      const mint = async (service: string) => {
        const r = await fetch(`${base}/v1/keychain/drops`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-agent-capability": cap },
          body: JSON.stringify({ service, purpose: "the task" }),
        });
        const { dropId, formPath } = (await r.json()) as { dropId: string; formPath: string };
        return { dropId, t: new URL(formPath, "http://x").searchParams.get("t")! };
      };
      let nonce = 0;
      const redeem = async ({ dropId, t }: { dropId: string; t: string }, secret: string) => {
        const waited = new Promise<void>((resolve) => {
          fired = resolve;
        });
        const path = `/v1/keychain/drops/${dropId}?t=${encodeURIComponent(t)}&_n=${nonce++}`;
        const body = JSON.stringify({ secret });
        const r = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            ...signedRequestHeaders(SECRET, "POST", path, body),
            "x-drop-owner": "U_A",
            "x-drop-owner-org": "acme",
            "content-type": "application/json",
          },
          body,
        });
        assert.equal(r.status, 200);
        await waited;
      };

      const alpha = await mint("alphasvc");
      const beta = await mint("betasvc");

      await redeem(alpha, "sk-alpha");
      assert.equal(fires.length, 1);
      assert.deepEqual(fires[0]!.pendingSiblings, ["betasvc"], "the first redeem knows its sibling is still pending");

      await redeem(beta, "sk-beta");
      assert.equal(fires.length, 2);
      assert.equal(fires[1]!.pendingSiblings, undefined, "the last redeem fires the plain resume");

      const gamma = await mint("gammasvc");
      await mint("deltasvc");
      const broken = built.secretDrops!.siblings;
      built.secretDrops!.siblings = () => Promise.reject(new Error("boom"));
      try {
        await redeem(gamma, "sk-gamma");
      } finally {
        built.secretDrops!.siblings = broken;
      }
      assert.equal(fires.length, 3, "a failed sibling scan must not cancel the wake");
      assert.equal(fires[2]!.pendingSiblings, undefined, "scan failure degrades to a wake with no sibling note");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
