import "./support/auto-fake-sprites.ts";

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer, createInsecureTestServer } from "../src/api/server.ts";
import { createPrincipalLinkService, PrincipalLinkError, type PrincipalLink } from "../src/identity/principal-links.ts";
import {
  canonicalPerson,
  installPrincipalLinks,
  personIds,
  personKey,
  samePerson,
  samePersonInDirectory,
} from "../src/directory/person.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { adminStatusFromGrants } from "../src/admin/admin-service.ts";
import { computeUsers } from "../src/admin/users.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const EMAIL = "jordan@acme.test";
const SLACK = "U0JORDAN";
const OIDC = "oidc:11f23f7cabe8a3778c0651be5112f1cd67387728be3d94afe6d758964c05d3c6:NDI3NjQ0";
const EVIDENCE = "bookface email pavitra@superserve.ai matched the Slack-verified directory email";

describe("principal link service: one person, several sign-ins", () => {
  it("links a sign-in to a canonical principal and resolves both directions", async () => {
    const links = createPrincipalLinkService();
    const row = await links.link({ principalId: OIDC, canonicalId: EMAIL, evidence: EVIDENCE, linkedBy: "admin" });
    assert.equal(row.canonicalId, EMAIL);
    assert.equal(links.canonical(OIDC), EMAIL);
    assert.deepEqual(links.aliases(EMAIL), [OIDC]);
    assert.equal(links.canonical(EMAIL), undefined, "the canonical id is not itself an alias");
    assert.equal((await links.list()).length, 1);
    const removed = await links.unlink(OIDC);
    assert.equal(removed?.principalId, OIDC);
    assert.equal(links.canonical(OIDC), undefined);
    assert.equal(await links.unlink(OIDC), null);
  });

  it("refuses self-links, chains, reversed links, missing evidence, and conflicting re-links", async () => {
    const links = createPrincipalLinkService();
    const reject = async (input: Parameters<typeof links.link>[0], status: number, re: RegExp) => {
      await assert.rejects(links.link(input), (e: unknown) => {
        assert.ok(e instanceof PrincipalLinkError);
        assert.equal(e.status, status);
        assert.match(e.message, re);
        return true;
      });
    };
    await reject(
      { principalId: EMAIL, canonicalId: "Jordan@Acme.Test", evidence: EVIDENCE, linkedBy: "a" },
      400,
      /itself/,
    );
    await reject({ principalId: OIDC, canonicalId: EMAIL, evidence: "", linkedBy: "a" }, 400, /evidence/);
    await reject({ principalId: "", canonicalId: EMAIL, evidence: EVIDENCE, linkedBy: "a" }, 400, /non-empty/);
    await links.link({ principalId: OIDC, canonicalId: EMAIL, evidence: EVIDENCE, linkedBy: "a" });
    const again = await links.link({
      principalId: OIDC,
      canonicalId: EMAIL.toUpperCase(),
      evidence: "x",
      linkedBy: "b",
    });
    assert.equal(again.linkedBy, "a", "re-linking to the same canonical is idempotent and keeps the first record");
    await reject(
      { principalId: OIDC, canonicalId: "casey@acme.test", evidence: EVIDENCE, linkedBy: "a" },
      409,
      /already/,
    );
    await reject(
      { principalId: "U0OTHER", canonicalId: OIDC, evidence: EVIDENCE, linkedBy: "a" },
      400,
      /itself linked/,
    );
    await reject(
      { principalId: EMAIL, canonicalId: "casey@acme.test", evidence: EVIDENCE, linkedBy: "a" },
      400,
      /canonical/,
    );
  });

  it("reads links written by another process on refresh", async () => {
    const backing = createMemoryMap<PrincipalLink>();
    const links = createPrincipalLinkService(backing);
    await links.refresh(true);
    assert.equal(links.canonical(OIDC), undefined);
    await backing.put(OIDC, {
      principalId: OIDC,
      canonicalId: EMAIL,
      evidence: EVIDENCE,
      linkedBy: "ops",
      createdAt: 1,
    });
    await links.refresh(true);
    assert.equal(links.canonical(OIDC), EMAIL);
  });
});

describe("person primitives fold a linked sign-in to its canonical principal", () => {
  afterEach(() => installPrincipalLinks(null));

  async function installed() {
    const links = createPrincipalLinkService();
    await links.link({ principalId: OIDC, canonicalId: EMAIL, evidence: EVIDENCE, linkedBy: "admin" });
    installPrincipalLinks(links);
    return links;
  }

  it("personKey, samePerson, canonicalPerson and personIds agree", async () => {
    assert.equal(samePerson(OIDC, EMAIL), false, "unlinked ids are different people");
    await installed();
    assert.equal(personKey(OIDC), EMAIL);
    assert.equal(samePerson(OIDC, "Jordan@Acme.test"), true);
    assert.equal(canonicalPerson(OIDC), EMAIL);
    assert.equal(canonicalPerson(EMAIL), EMAIL);
    assert.equal(canonicalPerson("U0STRANGER"), "U0STRANGER");
    assert.deepEqual(personIds(OIDC), [EMAIL, OIDC]);
    assert.deepEqual(personIds(EMAIL), [EMAIL, OIDC]);
    assert.deepEqual(personIds("U0STRANGER"), ["U0STRANGER"]);
    assert.equal(samePerson(OIDC, "casey@acme.test"), false);
  });

  it("the directory bridge reaches a linked sign-in through the roster row", async () => {
    await installed();
    const dir = createDirectoryStore();
    await dir.replace([{ principalId: EMAIL, displayName: "Jordan", type: "internal", slackId: SLACK }]);
    assert.equal(await samePersonInDirectory(dir, OIDC, SLACK), true);
    assert.equal(await samePersonInDirectory(dir, OIDC, "U0CASEY"), false);
  });

  it("the identity service classifies a linked sign-in as the canonical principal and deactivates the person", async () => {
    const links = createPrincipalLinkService();
    await links.link({ principalId: OIDC, canonicalId: EMAIL, evidence: EVIDENCE, linkedBy: "admin" });
    installPrincipalLinks(links);
    const identity = createIdentityService(undefined, { principalLinks: links });
    await identity.refresh(true);
    assert.equal(identity.classify(OIDC).id, EMAIL);
    assert.equal(identity.resolve({ externalId: OIDC }).id, EMAIL);
    assert.equal(identity.classify("U0STRANGER").id, "U0STRANGER");
    await identity.deactivate(OIDC);
    assert.equal(identity.classify(EMAIL).type, "guest", "deactivating one sign-in deactivates the person");
    await identity.reactivate(EMAIL);
    assert.equal(identity.classify(OIDC).type, "internal");
  });

  it("the keychain stores new credentials under the canonical owner and lists legacy ones from either id", async () => {
    await installed();
    const creds = createMemoryMap<KeychainCredential>();
    const keychain = createKeychain({
      creds,
      grants: createMemoryMap(),
      asks: createMemoryMap(),
      key: deriveConnectorKey("principal-links-test-key"),
    });
    const saved = await keychain.save({ ownerId: OIDC, service: "github", secret: "ghp_x", envKey: "GITHUB_TOKEN" });
    assert.equal(saved.ownerId, EMAIL);
    const legacy = await keychain.save({ ownerId: EMAIL, service: "linear", secret: "lin_x", envKey: "LINEAR_KEY" });
    await creds.merge(legacy.id, { ownerId: OIDC });
    const mine = await keychain.listByOwner(EMAIL);
    assert.deepEqual(mine.map((c) => c.service).sort(), ["github", "linear"]);
    const viaSignIn = await keychain.listByOwner(OIDC);
    assert.deepEqual(viaSignIn.map((c) => c.service).sort(), ["github", "linear"]);
    assert.equal(await keychain.readOwnSecret(OIDC, legacy.id), "lin_x");
    assert.equal(await keychain.readOwnSecret("casey@acme.test", legacy.id), null);
  });

  it("an admin grant held by either id makes the person an admin, and the users list shows one row", async () => {
    await installed();
    const grants = [{ principalId: OIDC, scopeId: scopeId("org", "acme"), role: "org_admin" as const }];
    assert.equal(adminStatusFromGrants(grants, EMAIL).isAdmin, true);
    const users = computeUsers({
      grants,
      participants: [
        { sessionId: "s1", principalId: OIDC, validFrom: 10, validTo: null, validFromSeq: null, validToSeq: null },
        { sessionId: "s2", principalId: EMAIL, validFrom: 20, validTo: null, validFromSeq: null, validToSeq: null },
      ],
      turns: [],
    });
    assert.equal(users.length, 1);
    assert.equal(users[0]!.principalId, EMAIL);
    assert.equal(users[0]!.sessionCount, 2);
    assert.equal(users[0]!.admin.isAdmin, true);
  });
});

describe("linked sign-ins across the HTTP surface", () => {
  const SECRET = "principal-links-source-secret".repeat(2);
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let nonce = 0;

  const signed = (method: string, rawPath: string, body = "", headers: Record<string, string> = {}) => {
    const path = `${rawPath}${rawPath.includes("?") ? "&" : "?"}_n=${nonce++}`;
    return fetch(`${base}${path}`, {
      method,
      headers: {
        ...signedRequestHeaders(SECRET, method, path, body),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body } : {}),
    });
  };
  const admin = { "x-admin-actor": "admin-alice@default-org" };
  const capFor = (actorId: string, scope = scopeId("personal", actorId)) =>
    mintCapabilityToken({ actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS }, SECRET);

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "principal-links-")), signingSecret: SECRET }));
    await built.app.upsertDirectory([{ principalId: EMAIL, displayName: "Jordan", type: "internal", slackId: SLACK }]);
    server = createServer(built.app, {
      signingSecret: SECRET,
      admin: built.admin,
      auditLog: built.auditLog,
      keychain: built.keychain,
      secretDrops: built.secretDrops,
      deliveries: built.deliveries,
      workspace: built.workspace,
      runs: built.runs,
      signals: built.signals,
      identity: built.identity,
      principalLinks: built.principalLinks,
      directory: built.directory,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("only an org admin manages links, the agent never does, and a directory member stays canonical", async () => {
    const body = JSON.stringify({ principalId: OIDC, canonicalId: EMAIL, evidence: EVIDENCE });
    assert.equal(
      (await signed("POST", "/v1/admin/principal-links", body, { "x-admin-actor": "U0STRANGER@default-org" })).status,
      403,
    );
    const agent = await fetch(`${base}/v1/admin/principal-links`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await capFor("admin-alice") },
      body,
    });
    assert.equal(agent.status, 403);
    const reversed = await signed(
      "POST",
      "/v1/admin/principal-links",
      JSON.stringify({ principalId: EMAIL, canonicalId: OIDC, evidence: EVIDENCE }),
      admin,
    );
    assert.equal(reversed.status, 400);
    assert.match(((await reversed.json()) as { message: string }).message, /directory member/);
    const created = await signed("POST", "/v1/admin/principal-links", body, admin);
    assert.equal(created.status, 200);
    const listed = (await (await signed("GET", "/v1/admin/principal-links", "", admin)).json()) as {
      links: PrincipalLink[];
    };
    assert.equal(listed.links.length, 1);
    assert.equal(listed.links[0]!.linkedBy, "admin-alice");
    const audit = await built.auditLog.tail({ limit: 50, action: "principal_link.create" });
    assert.ok(audit.some((e) => e.resource === `${OIDC} -> ${EMAIL}`));
  });

  it("surfaces resolve a sign-in to its canonical principal", async () => {
    const r = await signed("GET", `/v1/principals/${encodeURIComponent(OIDC)}/canonical`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { principalId: OIDC, canonicalId: EMAIL });
    const plain = await signed("GET", `/v1/principals/${encodeURIComponent(EMAIL)}/canonical`);
    assert.deepEqual(await plain.json(), { principalId: EMAIL, canonicalId: EMAIL });
  });

  it("a secret drop minted for the Slack identity opens and redeems under the linked sign-in", async () => {
    const minted = await fetch(`${base}/v1/keychain/drops`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await capFor(EMAIL) },
      body: JSON.stringify({ service: "stripe", purpose: "charge cards" }),
    });
    assert.equal(minted.status, 200);
    const { dropId, formPath } = (await minted.json()) as { dropId: string; formPath: string };
    const t = new URL(formPath, "http://x").searchParams.get("t")!;
    const owner = (id: string) => ({ "x-drop-owner": id, "x-drop-owner-org": "default-org" });
    assert.equal(
      (
        await signed(
          "GET",
          `/v1/keychain/drops/${dropId}/form?t=${encodeURIComponent(t)}`,
          "",
          owner("casey@acme.test"),
        )
      ).status,
      403,
    );
    assert.equal(
      (await signed("GET", `/v1/keychain/drops/${dropId}/form?t=${encodeURIComponent(t)}`, "", owner(OIDC))).status,
      200,
    );
    const redeemed = await signed(
      "POST",
      `/v1/keychain/drops/${dropId}?t=${encodeURIComponent(t)}`,
      JSON.stringify({ secret: "sk_live_x" }),
      owner(OIDC),
    );
    assert.equal(redeemed.status, 200);
    const { credential } = (await redeemed.json()) as { credential: { id: string; ownerId: string } };
    assert.equal(credential.ownerId, EMAIL, "the credential belongs to the canonical principal");
    assert.equal(await built.keychain!.readOwnSecret(OIDC, credential.id), "sk_live_x");
  });

  it("deleting the link restores two separate principals", async () => {
    const removed = await signed("DELETE", `/v1/admin/principal-links/${encodeURIComponent(OIDC)}`, "", admin);
    assert.equal(removed.status, 200);
    assert.equal(
      (await signed("DELETE", `/v1/admin/principal-links/${encodeURIComponent(OIDC)}`, "", admin)).status,
      404,
    );
    assert.equal(samePerson(OIDC, EMAIL), false);
    assert.equal(built.identity.classify(OIDC).id, OIDC);
  });
});

describe("the portal identity gate accepts a linked sign-in for the canonical viewer", () => {
  const PID = "portal-only-identity-secret-for-tests-02";
  let server: Server;
  let base: string;
  let built: BuiltApp;

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "principal-links-gate-")) }));
    await built.principalLinks.link({ principalId: OIDC, canonicalId: EMAIL, evidence: EVIDENCE, linkedBy: "test" });
    await built.identity.refresh(true);
    server = createInsecureTestServer(built.app, {
      portalIdentitySecret: PID,
      requireSignedPortalIdentity: true,
      scheduler: built.scheduler,
      identity: built.identity,
      sessionShares: built.sessionShares,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = async (p: string, viewer: string) =>
    fetch(`${base}/v1/sessions/nope?viewer=${encodeURIComponent(viewer)}`, {
      headers: { "x-portal-identity": await mintSignedPayload({ p, exp: Date.now() + 60_000 }, PID) },
    });

  it("passes for the canonical viewer, the sign-in itself, and rejects another person", async () => {
    assert.equal((await get(OIDC, EMAIL)).status, 404);
    assert.equal((await get(OIDC, OIDC)).status, 404);
    assert.equal((await get(EMAIL, OIDC)).status, 404);
    assert.equal((await get(OIDC, "casey@acme.test")).status, 403);
  });
});
