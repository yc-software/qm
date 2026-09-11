import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { buildApp, serverDeps, type BuiltApp } from "../src/wiring.ts";
import { type TurnRequest } from "../src/types.ts";
import {
  mintCapabilityToken,
  verifyCapabilityToken,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  CREDENTIAL_BROKER_AUD,
} from "../src/auth/capability-token.ts";
import type { BrokerFetch } from "../src/api/credential-broker.ts";
import type { GitHttpFetch } from "../src/api/git-http-broker.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
import type { AclStore } from "../src/acl/acl-store.ts";

const SECRET = "svc-cred-route-secret".repeat(3);
const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(wrapAcl?: (acl: AclStore) => AclStore): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "svc-cred-route-")) }));
  const acl = wrapAcl?.(built.acl) ?? built.acl;
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    serviceCreds: built.serviceCreds,
    acl,
    credentialUsage: built.credentialUsage,
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function startBroker(brokerFetch: BrokerFetch): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "svc-cred-broker-")), signingSecret: SECRET }),
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    config: built.config,
    serviceCreds: built.serviceCreds,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    auditLog: built.auditLog,
    brokerFetch,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function startGitBroker(gitHttpFetch: GitHttpFetch): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "svc-cred-git-broker-")), signingSecret: SECRET }),
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    config: built.config,
    serviceCreds: built.serviceCreds,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    auditLog: built.auditLog,
    gitHttpFetch,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const brokerToken = (credentials: string[], aud: string = CREDENTIAL_BROKER_AUD) =>
  mintCapabilityToken(
    { actorId: "U1", scopeId: "personal:U1", aud, credentials, exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

const putCred = (base: string, b: object, headers = ADMIN) =>
  fetch(`${base}/v1/admin/scopes/org:default-org/service-credentials`, {
    method: "PUT",
    headers,
    body: JSON.stringify(b),
  });
const getCfg = async (base: string) =>
  (await (await fetch(`${base}/v1/admin/scopes/org:default-org`, { headers: ADMIN })).json()) as {
    serviceCredentials: Array<{
      slug: string;
      name: string;
      host: string;
      deployments?: boolean;
      hasSecret: boolean;
      enabled: boolean;
      grantees: string[];
      usageCount: number;
      usageTruncated: boolean;
      updatedAt: number;
      injection?: { header?: string; scheme?: string; actor?: boolean };
      allowedMethods?: string[];
      allowedPathPrefixes?: string[];
    }>;
  };

test("admin creates a credential (default org-wide); GET projects it WITHOUT the secret", async () => {
  const srv = start();
  try {
    const r = await putCred(srv.base, {
      slug: "x-firehose",
      name: "X firehose",
      secret: "super-secret-bearer",
      host: "api.x.com",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/2/tweets/search/"],
    });
    assert.equal(r.status, 200);

    const cfg = await getCfg(srv.base);
    const cred = cfg.serviceCredentials.find((c) => c.slug === "x-firehose");
    assert.ok(cred);
    assert.equal(cred!.hasSecret, true);
    assert.deepEqual(cred!.grantees, ["org:default-org"]);
    assert.equal(cred!.usageCount, 0);
    assert.equal(cred!.usageTruncated, false);
    assert.doesNotMatch(JSON.stringify(cfg), /super-secret-bearer/);
  } finally {
    await srv.close();
  }
});

test("env-delivery credential: envKey validated, host refused, duplicates refused; projection carries delivery", async () => {
  const srv = start();
  try {
    assert.equal(
      (await putCred(srv.base, { slug: "browse-steel", name: "Steel", delivery: "env", secret: "s1" })).status,
      400,
      "envKey required",
    );
    assert.equal(
      (await putCred(srv.base, { slug: "browse-steel", name: "Steel", delivery: "env", envKey: "lower", secret: "s1" }))
        .status,
      400,
      "UPPER_SNAKE only",
    );
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "browse-steel",
          name: "Steel",
          delivery: "env",
          envKey: "AGENT_X",
          secret: "s1",
        })
      ).status,
      400,
      "AGENT_* reserved",
    );
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "browse-steel",
          name: "Steel",
          delivery: "env",
          envKey: "STEEL_API_KEY",
          host: "steel.dev",
          secret: "s1",
        })
      ).status,
      400,
      "host is broker-only",
    );
    assert.equal(
      (await putCred(srv.base, { slug: "x", name: "X", envKey: "X_KEY", host: "api.x.com", secret: "s" })).status,
      400,
      "envKey is env-only",
    );

    const ok = await putCred(srv.base, {
      slug: "browse-steel",
      name: "Steel",
      delivery: "env",
      envKey: "STEEL_API_KEY",
      secret: "s1",
    });
    assert.equal(ok.status, 200);
    const dup = await putCred(srv.base, {
      slug: "browse-other",
      name: "Other",
      delivery: "env",
      envKey: "STEEL_API_KEY",
      secret: "s2",
    });
    assert.equal(dup.status, 400);
    assert.match(await dup.text(), /already delivered by credential/);

    const cfg = await getCfg(srv.base);
    const cred = cfg.serviceCredentials.find(
      (c) => c.slug === "browse-steel",
    ) as (typeof cfg.serviceCredentials)[number] & { delivery?: string; envKey?: string };
    assert.equal(cred?.delivery, "env");
    assert.equal(cred?.envKey, "STEEL_API_KEY");
    assert.doesNotMatch(JSON.stringify(cfg), /s1/);
  } finally {
    await srv.close();
  }
});

test("env-delivery accepts person/team grantees — grants now gate env injection like broker calls", async () => {
  const srv = start();
  try {
    const narrowed = await putCred(srv.base, {
      slug: "browse-steel",
      name: "Steel",
      delivery: "env",
      envKey: "STEEL_API_KEY",
      secret: "s1",
      grantees: ["personal:alice@default-org"],
    });
    assert.equal(narrowed.status, 200, "a person grant on an env credential is allowed");

    const orgWide = await putCred(srv.base, {
      slug: "browse-steel-wide",
      name: "Steel wide",
      delivery: "env",
      envKey: "STEEL_WIDE_API_KEY",
      secret: "s1",
      grantees: ["org:default-org"],
    });
    assert.equal(orgWide.status, 200, "the org grant is fine too");
  } finally {
    await srv.close();
  }
});

test("a non-admin cannot vend a credential (authz unchanged)", async () => {
  const srv = start();
  try {
    const denied = await putCred(
      srv.base,
      { slug: "k", name: "K", secret: "s", host: "h.example" },
      { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
    );
    assert.equal(denied.status, 403);
  } finally {
    await srv.close();
  }
});

test("service credentials are org-scoped — a non-org target is rejected", async () => {
  const srv = start();
  try {
    const r = await fetch(`${srv.base}/v1/admin/scopes/personal:U1/service-credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" },
      body: JSON.stringify({ slug: "k", name: "K", secret: "s", host: "h.example" }),
    });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /org-scoped/);
  } finally {
    await srv.close();
  }
});

test("a new credential without a secret is rejected; an update may omit it", async () => {
  const srv = start();
  try {
    assert.equal((await putCred(srv.base, { slug: "k", name: "K", host: "h.example" })).status, 400);
    assert.equal((await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" })).status, 200);
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "K2", host: "h.example", expectedUpdatedAt: version })).status,
      200,
    );
    assert.equal((await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "k")!.name, "K2");
  } finally {
    await srv.close();
  }
});

test("partial credential updates preserve capability lists while explicit empty lists clear them", async () => {
  const srv = start();
  try {
    await putCred(srv.base, {
      slug: "k",
      name: "K",
      secret: "s",
      host: "h.example",
      injection: { header: "X-Key", scheme: "Token", actor: true },
      allowedMethods: ["POST"],
      allowedPathPrefixes: ["/v1/"],
      enabled: true,
    });
    let loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "Renamed", host: "h.example", expectedUpdatedAt: loaded.updatedAt }))
        .status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.deepEqual(loaded.allowedMethods, ["POST"]);
    assert.deepEqual(loaded.allowedPathPrefixes, ["/v1/"]);
    assert.deepEqual(loaded.injection, { header: "X-Key", scheme: "Token", actor: true });
    assert.equal(loaded.enabled, true);

    assert.equal(
      (
        await putCred(srv.base, {
          slug: "k",
          name: "Renamed",
          host: "h.example",
          injection: {},
          allowedMethods: [],
          allowedPathPrefixes: [],
          enabled: false,
          expectedUpdatedAt: loaded.updatedAt,
        })
      ).status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.deepEqual(loaded.allowedMethods, []);
    assert.deepEqual(loaded.allowedPathPrefixes, []);
    assert.equal(loaded.injection, undefined);
    assert.equal(loaded.enabled, false);

    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "Again", host: "h.example", expectedUpdatedAt: loaded.updatedAt }))
        .status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(loaded.enabled, false, "omitting enabled preserves a disabled credential");
  } finally {
    await srv.close();
  }
});

test("admin credential edits reject a stale loaded revision", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "K2", host: "h.example", expectedUpdatedAt: loaded.updatedAt }))
        .status,
      200,
    );
    const stale = await putCred(srv.base, {
      slug: "k",
      name: "stale",
      host: "h.example",
      expectedUpdatedAt: loaded.updatedAt,
    });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /changed after this editor was loaded/);
  } finally {
    await srv.close();
  }
});

test("an editor whose credential was remotely deleted cannot recreate it with its stale edit token", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(
      (await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: loaded.updatedAt })).status,
      200,
    );

    const staleEdit = await putCred(srv.base, {
      slug: "k",
      name: "Resurrected",
      host: "h.example",
      expectedUpdatedAt: loaded.updatedAt,
    });
    assert.equal(staleEdit.status, 409);
    assert.match(await staleEdit.text(), /changed after this editor was loaded/);
    assert.equal(
      (await getCfg(srv.base)).serviceCredentials.some((credential) => credential.slug === "k"),
      false,
    );
  } finally {
    await srv.close();
  }
});

test("existing credential edits and deletes require the loaded revision", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const edit = await putCred(srv.base, { slug: "k", name: "Changed", host: "h.example" });
    assert.equal(edit.status, 400);
    assert.match(await edit.text(), /require the version you loaded/);
    const deletion = await putCred(srv.base, { slug: "k", delete: true });
    assert.equal(deletion.status, 400);
    assert.match(await deletion.text(), /require the version you loaded/);
    assert.equal((await getCfg(srv.base)).serviceCredentials[0]!.name, "K");
  } finally {
    await srv.close();
  }
});

test("a partial ACL failure rolls a credential edit and its grants back to the verified snapshot", async () => {
  let failGrant = false;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (failGrant) {
        failGrant = false;
        throw new Error("injected grant failure");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    await srv.built.acl.revoke("org:default-org", "service-cred:k", "org:default-org", "seed");
    await srv.built.acl.grant({
      ownerScopeId: "org:default-org",
      ref: "service-cred:k",
      granteeScopeId: "org:default-org",
      permission: "write",
      grantedBy: "original-governor",
    });
    const grantsBefore = await srv.built.acl.grantsFor("org:default-org", "service-cred:k");
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    failGrant = true;
    const edit = await putCred(srv.base, {
      slug: "k",
      name: "Changed",
      host: "h.example",
      grantees: ["personal:alice"],
      expectedUpdatedAt: before.updatedAt,
    });
    assert.equal(edit.status, 500);
    assert.match(await edit.text(), /previous credential and grants were restored/);
    const after = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(after.name, "K");
    assert.deepEqual(after.grantees, ["org:default-org"]);
    assert.deepEqual(await srv.built.acl.grantsFor("org:default-org", "service-cred:k"), grantsBefore);
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "s");
  } finally {
    await srv.close();
  }
});

test("credential rollback preserves a concurrent credential update", async () => {
  let concurrentWrite: (() => Promise<void>) | null = null;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (concurrentWrite) {
        const write = concurrentWrite;
        concurrentWrite = null;
        await write();
        throw new Error("failure after concurrent credential write");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    concurrentWrite = async () => {
      const current = (await srv.built.serviceCreds.listServiceCredentials("org:default-org")).find(
        (credential) => credential.slug === "k",
      )!;
      const updatedAt = await srv.built.serviceCreds.setServiceCredentialIfCurrent(
        "org:default-org",
        {
          slug: "k",
          name: "Concurrent",
          host: "concurrent.example",
          updatedBy: "concurrent-governor",
        },
        current.updatedAt,
      );
      assert.notEqual(updatedAt, null);
    };
    const edit = await putCred(srv.base, {
      slug: "k",
      name: "Changed",
      host: "h.example",
      grantees: ["personal:alice"],
      expectedUpdatedAt: before.updatedAt,
    });
    assert.equal(edit.status, 500);
    assert.match(await edit.text(), /rollback could not be verified/);
    const after = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(after.name, "Concurrent");
    assert.equal(after.host, "concurrent.example");
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "s");
  } finally {
    await srv.close();
  }
});

test("failed credential creation does not delete a concurrent update of the new record", async () => {
  let concurrentWrite: (() => Promise<void>) | null = null;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (concurrentWrite) {
        const write = concurrentWrite;
        concurrentWrite = null;
        await write();
        throw new Error("failure after concurrent create update");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    concurrentWrite = async () => {
      const created = (await srv.built.serviceCreds.listServiceCredentials("org:default-org")).find(
        (credential) => credential.slug === "new",
      )!;
      assert.notEqual(
        await srv.built.serviceCreds.setServiceCredentialIfCurrent(
          "org:default-org",
          {
            slug: "new",
            name: "Concurrent",
            host: "concurrent.example",
            updatedBy: "concurrent-governor",
          },
          created.updatedAt,
        ),
        null,
      );
    };
    const response = await putCred(srv.base, { slug: "new", name: "New", secret: "s", host: "new.example" });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /rollback could not be verified/);
    const saved = (await getCfg(srv.base)).serviceCredentials.find((credential) => credential.slug === "new")!;
    assert.equal(saved.name, "Concurrent");
    assert.equal(saved.host, "concurrent.example");
  } finally {
    await srv.close();
  }
});

test("failed credential deletion does not overwrite a concurrent recreation", async () => {
  let concurrentWrite: (() => Promise<void>) | null = null;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (concurrentWrite) {
        const write = concurrentWrite;
        concurrentWrite = null;
        await write();
        throw new Error("failure after concurrent recreation");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "Original", secret: "old", host: "old.example" });
    const original = (await getCfg(srv.base)).serviceCredentials.find((credential) => credential.slug === "k")!;
    concurrentWrite = async () => {
      assert.notEqual(
        await srv.built.serviceCreds.setServiceCredentialIfAbsent("org:default-org", {
          slug: "k",
          name: "Concurrent",
          secret: "new",
          host: "concurrent.example",
          updatedBy: "concurrent-governor",
        }),
        null,
      );
    };
    const response = await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: original.updatedAt });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /rollback could not be verified/);
    const saved = (await getCfg(srv.base)).serviceCredentials.find((credential) => credential.slug === "k")!;
    assert.equal(saved.name, "Concurrent");
    assert.equal(saved.host, "concurrent.example");
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "new");
  } finally {
    await srv.close();
  }
});

test("credential rollback preserves a concurrent grant tuple instead of replacing it with the snapshot", async () => {
  let injectConcurrentGrant = false;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (injectConcurrentGrant) {
        injectConcurrentGrant = false;
        await acl.grant({
          ownerScopeId,
          ref,
          granteeScopeId: "team:concurrent",
          permission: "write",
          grantedBy: "concurrent-governor",
        });
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    injectConcurrentGrant = true;
    const edit = await putCred(srv.base, {
      slug: "k",
      name: "Changed",
      host: "h.example",
      grantees: ["personal:alice"],
      expectedUpdatedAt: before.updatedAt,
    });
    assert.equal(edit.status, 500);
    assert.match(await edit.text(), /rollback could not be verified/);
    assert.deepEqual(
      (await srv.built.acl.grantsFor("org:default-org", "service-cred:k")).find(
        (grant) => grant.granteeScopeId === "team:concurrent",
      ),
      {
        ownerScopeId: "org:default-org",
        ref: "service-cred:k",
        granteeScopeId: "team:concurrent",
        permission: "write",
        grantedBy: "concurrent-governor",
      },
    );
  } finally {
    await srv.close();
  }
});

test("an ACL failure after conditional delete recreates and verifies the credential plus grants", async () => {
  let failRevoke = false;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (failRevoke) {
        failRevoke = false;
        throw new Error("injected revoke failure");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    failRevoke = true;
    const deletion = await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: before.updatedAt });
    assert.equal(deletion.status, 500);
    assert.match(await deletion.text(), /previous credential and grants were restored/);
    const after = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(after.name, "K");
    assert.deepEqual(after.grantees, ["org:default-org"]);
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "s");
  } finally {
    await srv.close();
  }
});

test("parallel credential edits from one loaded revision allow one winner and one conflict", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    const responses = await Promise.all([
      putCred(srv.base, {
        slug: "k",
        name: "Left",
        host: "h.example",
        grantees: ["personal:left"],
        expectedUpdatedAt: version,
      }),
      putCred(srv.base, {
        slug: "k",
        name: "Right",
        host: "h.example",
        grantees: ["personal:right"],
        expectedUpdatedAt: version,
      }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const saved = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.deepEqual(saved.grantees, [saved.name === "Left" ? "personal:left" : "personal:right"]);
  } finally {
    await srv.close();
  }
});

test("re-sharing reconciles the ACL allow-list (org-wide → specific people → delete)", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.grantees, ["org:default-org"]);

    const createdVersion = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    await putCred(srv.base, {
      slug: "k",
      name: "K",
      host: "h.example",
      grantees: ["personal:bob", "personal:alice"],
      expectedUpdatedAt: createdVersion,
    });
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.grantees.sort(), [
      "personal:alice",
      "personal:bob",
    ]);

    const sharedVersion = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    assert.equal((await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: sharedVersion })).status, 200);
    assert.equal((await getCfg(srv.base)).serviceCredentials.length, 0);
    const grants = await srv.built.acl.grantsFor("org:default-org", "service-cred:k");
    assert.equal(grants.length, 0);
  } finally {
    await srv.close();
  }
});

test("channel and group project grantees are accepted and saved", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    const r = await putCred(srv.base, {
      slug: "k",
      name: "K",
      host: "h.example",
      grantees: ["channel:C1", "group:G1", "personal:bob"],
      expectedUpdatedAt: version,
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.grantees.sort(), [
      "channel:C1",
      "group:G1",
      "personal:bob",
    ]);
  } finally {
    await srv.close();
  }
});

test("malformed and cross-org grantees are rejected without changing grants", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    for (const grantee of [
      "unknown:G1",
      "group:",
      "group:group:G1",
      "group:G1\n",
      "group:G1\u0000",
      "group: G1",
      "channel:C1\t",
      "personal:channel:C1",
      "channel:",
      "org:other-org",
    ]) {
      const r = await putCred(srv.base, {
        slug: "k",
        name: "K",
        host: "h.example",
        grantees: [grantee],
        expectedUpdatedAt: version,
      });
      assert.equal(r.status, 400);
      assert.match(await r.text(), /grantee must be/);
    }
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.grantees, ["org:default-org"]);
  } finally {
    await srv.close();
  }
});

test("credential capability grammar rejects malformed headers, methods, and paths before mutation", async () => {
  const srv = start();
  try {
    const base = { slug: "k", name: "K", secret: "s", host: "h.example" };
    assert.equal((await putCred(srv.base, { ...base, injection: { header: "Bad Header" } })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, injection: { header: "X-QM-Actor" } })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, injection: { actor: "true" } })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, allowedMethods: ["GET /oops"] })).status, 400);
    assert.equal((await putCred(srv.base, { ...base, allowedPathPrefixes: ["relative/path"] })).status, 400);
    assert.equal((await getCfg(srv.base)).serviceCredentials.length, 0);
  } finally {
    await srv.close();
  }
});

const broker = (base: string, token: string, body: object) =>
  fetch(`${base}/v1/credentials/broker`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": token },
    body: JSON.stringify(body),
  });

async function readStreamBody(stream?: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  if (!stream) return "";
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

test("broker route: a credential-broker token uses the secret by proxy; usage is recorded", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const srv = startBroker(async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status: 200, contentType: "application/json", text: async () => '{"data":[]}' };
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "x-firehose",
      name: "X",
      secret: "super-secret-bearer",
      host: "api.x.com",
      allowedPathPrefixes: ["/2/"],
    });
    const res = await broker(srv.base, await brokerToken(["x-firehose"]), {
      credential: "x-firehose",
      method: "GET",
      url: "https://api.x.com/2/tweets/search/recent?query=ai",
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { status: number; body: string };
    assert.equal(json.status, 200);
    assert.equal(json.body, '{"data":[]}');
    assert.equal(calls[0]!.headers["Authorization"], "Bearer super-secret-bearer");
    assert.doesNotMatch(JSON.stringify(json), /super-secret-bearer/);
    assert.equal((await srv.built.credentialUsage.list({ slug: "x-firehose" })).length, 1);
  } finally {
    await srv.close();
  }
});

test("broker route: a slug NOT in the token's set is refused (403)", async () => {
  const srv = startBroker(async () => {
    throw new Error("must not fetch");
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "x-firehose",
      name: "X",
      secret: "s",
      host: "api.x.com",
    });
    const res = await broker(srv.base, await brokerToken([]), {
      credential: "x-firehose",
      url: "https://api.x.com/x",
      scopeId: "group:G1",
      credentials: ["x-firehose"],
      liveActor: true,
      actorId: "admin",
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not_entitled/);
  } finally {
    await srv.close();
  }
});

test("broker route: a control-plane token is rejected (cross-onramp wall); no token → 401", async () => {
  const srv = startBroker(async () => {
    throw new Error("must not fetch");
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "x-firehose",
      name: "X",
      secret: "s",
      host: "api.x.com",
    });
    const r1 = await broker(srv.base, await brokerToken(["x-firehose"], CONTROL_PLANE_AUD), {
      credential: "x-firehose",
      url: "https://api.x.com/x",
    });
    assert.equal(r1.status, 403);
    assert.match(await r1.text(), /credential-broker/);
    const r2 = await fetch(`${srv.base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "x-firehose", url: "https://api.x.com/x" }),
    });
    assert.equal(r2.status, 401);
  } finally {
    await srv.close();
  }
});

test("git http broker streams smart-http GET and POST through an entitled service credential", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const srv = startGitBroker(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: await readStreamBody(init.body) });
    return {
      status: 200,
      headers: {
        "content-type":
          init.method === "GET"
            ? "application/x-git-receive-pack-advertisement"
            : "application/x-git-receive-pack-result",
      },
      body: Readable.from([init.method === "GET" ? "001e# service=git-receive-pack\n0000" : "0000"]),
    };
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "gitlab",
      name: "GitLab git",
      secret: "dXNlcjp0b2tlbg==",
      host: "gitlab.example",
      injection: { scheme: "Basic " },
      allowedMethods: ["GET", "POST"],
      allowedPathPrefixes: ["/acme/repo.git"],
    });

    const token = await brokerToken(["gitlab"]);
    const discovery = await fetch(
      `${srv.base}/v1/credentials/git/gitlab/acme/repo.git/info/refs?service=git-receive-pack`,
      {
        headers: { "x-agent-capability": token, "git-protocol": "version=2" },
      },
    );
    assert.equal(discovery.status, 200);
    assert.match(discovery.headers.get("content-type") ?? "", /x-git-receive-pack-advertisement/);
    assert.match(await discovery.text(), /git-receive-pack/);

    const push = await fetch(`${srv.base}/v1/credentials/git/gitlab/acme/repo.git/git-receive-pack`, {
      method: "POST",
      headers: {
        "x-agent-capability": token,
        "content-type": "application/x-git-receive-pack-request",
        "git-protocol": "version=2",
      },
      body: "PACKDATA",
    });
    assert.equal(push.status, 200);
    assert.equal(await push.text(), "0000");

    assert.equal(calls[0]!.url, "https://gitlab.example/acme/repo.git/info/refs?service=git-receive-pack");
    assert.equal(calls[0]!.headers.Authorization, "Basic dXNlcjp0b2tlbg==");
    assert.equal(calls[0]!.headers["git-protocol"], "version=2");
    assert.equal(calls[1]!.url, "https://gitlab.example/acme/repo.git/git-receive-pack");
    assert.equal(calls[1]!.headers.Authorization, "Basic dXNlcjp0b2tlbg==");
    assert.equal(calls[1]!.headers["content-type"], "application/x-git-receive-pack-request");
    assert.equal(calls[1]!.body, "PACKDATA");
    assert.equal((await srv.built.credentialUsage.list({ slug: "gitlab" })).filter((r) => r.status === "ok").length, 2);
  } finally {
    await srv.close();
  }
});

test("git http broker enforces broker-token audience, entitlement, method, and path", async () => {
  const srv = startGitBroker(async () => {
    throw new Error("must not fetch");
  });
  try {
    await srv.built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "gitlab",
      name: "GitLab git",
      secret: "s",
      host: "gitlab.example",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/acme/repo.git"],
    });
    const path = `${srv.base}/v1/credentials/git/gitlab/acme/repo.git/git-receive-pack`;

    assert.equal((await fetch(path)).status, 401);
    assert.equal(
      (await fetch(path, { headers: { "x-agent-capability": await brokerToken(["gitlab"], CONTROL_PLANE_AUD) } }))
        .status,
      403,
    );
    assert.equal((await fetch(path, { headers: { "x-agent-capability": await brokerToken([]) } })).status, 403);
    assert.equal(
      (
        await fetch(path.replace("/acme/repo.git/", "/other/repo.git/"), {
          headers: { "x-agent-capability": await brokerToken(["gitlab"]) },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(path, {
          method: "POST",
          headers: { "x-agent-capability": await brokerToken(["gitlab"]) },
          body: "PACK",
        })
      ).status,
      403,
    );
  } finally {
    await srv.close();
  }
});

const internalActor = { externalId: "U1" };
const dm = (text: string): TurnRequest => ({
  surface: "test",
  origin: { kind: "human" },
  actor: internalActor,
  conversation: { kind: "dm", threadRef: "dm:U1:t1" },
  text,
});

function buildWithCapture() {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "svc-cred-stamp-")),
    signingSecret: SECRET,
    apiBaseUrl: "http://core.internal",
  });
  const built = buildApp(config);
  let captured: Record<string, string> | undefined;
  const realProvision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = async (layers, opts) => {
    captured = opts?.env;
    return realProvision(layers, opts);
  };
  return { built, config, env: () => captured };
}

test("orchestrator stamps AGENT_CREDENTIAL_TOKEN with an org-wide credential's slug", async () => {
  const { built, env } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "admin",
  });

  const res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  const token = env()?.AGENT_CREDENTIAL_TOKEN;
  assert.ok(token, "expected a credential-broker token in the sandbox env");
  const claims = await verifyCapabilityToken(token!, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.aud, CREDENTIAL_BROKER_AUD);
  assert.deepEqual(claims?.credentials, ["x-firehose"]);

  const actor = { externalId: "B-LEGACY", isBot: true };
  await built.app.turn({
    surface: "slack",
    actor,
    botActor: true,
    liveActor: true,
    conversation: {
      kind: "channel",
      threadRef: "ch:C1:bot",
      channelRef: "C1",
      isPrivate: true,
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!run echo bot",
  });
  const botClaims = await verifyCapabilityToken(env()!.AGENT_CREDENTIAL_TOKEN!, TEST_CAPABILITY_SECRET);
  assert.equal(botClaims?.botActor, true);
  assert.equal(botClaims?.liveActor, true);
  assert.deepEqual(botClaims?.members, [{ id: "B-LEGACY", type: "internal" }]);
});

test("orchestrator does NOT stamp a credential granted only to someone else", async () => {
  const { built, env } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "personal:U2",
    permission: "read",
    grantedBy: "admin",
  });

  const res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined, "an unentitled session must get no credential token");
});

test("a channel grantee stamps the credential in that channel's conversations and nowhere else", async () => {
  const { built, env } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "channel:C1",
    permission: "read",
    grantedBy: "admin",
  });

  const channelTurn = (channelRef: string): TurnRequest => ({
    surface: "slack",
    origin: { kind: "human" },
    actor: internalActor,
    conversation: {
      kind: "channel",
      threadRef: `ch:${channelRef}:t1`,
      channelRef,
      audience: [internalActor, { externalId: "U2" }],
      publishMembers: [internalActor, { externalId: "U2" }],
    },
    text: "!run echo hi",
  });

  let res = await built.app.turn(channelTurn("C1"));
  assert.equal(res.status, "ok", res.reason);
  const token = env()?.AGENT_CREDENTIAL_TOKEN;
  assert.ok(token, "the granted channel's conversation should get a credential token");
  const claims = await verifyCapabilityToken(token!, TEST_CAPABILITY_SECRET);
  assert.deepEqual(claims?.credentials, ["x-firehose"]);

  res = await built.app.turn(channelTurn("C2"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined, "another channel must not get the credential");

  res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined, "a member's DM must not get a channel-granted credential");
});

test("workgroup broker tracer", async () => {
  const { built, env } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "project-a",
    name: "Project A",
    secret: "dummy-project-a-secret",
    host: "h.example",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:project-a",
    granteeScopeId: "group:A",
    permission: "read",
    grantedBy: "admin",
  });
  const request: TurnRequest = {
    ...dm("!run echo hi"),
    origin: { kind: "direct" },
    conversation: {
      kind: "group",
      channelRef: "A",
      threadRef: "grp:A:tracer",
      audience: [internalActor],
    },
  };
  const result = await built.app.turn(request);
  assert.equal(result.status, "ok", result.reason);
  const token = env()?.AGENT_CREDENTIAL_TOKEN;
  assert.ok(token, "an admitted workgroup turn must receive its granted broker credential");
  const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.scopeId, "group:A");
  assert.deepEqual(claims?.credentials, ["project-a"]);
  const prompt = await built.app.turn({ ...request, text: "!sysprompt" });
  assert.match(prompt.reply ?? "", /project-a/);
  assert.match(prompt.reply ?? "", /AGENT_CREDENTIAL_TOKEN/);
});

test("group project credentials follow the current turn across projects and a DM", async () => {
  const { built, env } = buildWithCapture();
  await built.directory.upsertGroup("A", ["U1", "U2"]);
  await built.directory.upsertGroup("B", ["U1", "U2"]);
  for (const project of ["A", "B"]) {
    await built.serviceCreds.setServiceCredential("org:default-org", {
      slug: `project-${project.toLowerCase()}`,
      name: project,
      secret: "s",
      host: "h.example",
    });
    await built.acl.grant({
      ownerScopeId: "org:default-org",
      ref: `service-cred:project-${project.toLowerCase()}`,
      granteeScopeId: `group:${project}`,
      permission: "read",
      grantedBy: "admin",
    });
  }
  for (const [project, actorId] of [
    ["A", "U1"],
    ["B", "U1"],
    ["A", "U2"],
    ["A", "U3"],
  ] as const) {
    if (actorId === "U3") await built.directory.upsertGroup("A", ["U1", "U2", "U3"]);
    const actor = { externalId: actorId };
    const request: TurnRequest = {
      ...dm("!run echo hi"),
      surface: "web",
      origin: { kind: "direct" },
      actor,
      conversation: {
        kind: "group",
        channelRef: project,
        threadRef: `grp:${project}:${actorId}`,
        audience: [actor],
      },
    };
    const result = await built.app.turn(request);
    assert.equal(result.status, "ok", result.reason);
    const token = env()?.AGENT_CREDENTIAL_TOKEN;
    assert.ok(token);
    const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
    assert.equal(claims?.scopeId, `group:${project}`);
    assert.equal(claims?.actorId, actorId);
    assert.deepEqual(claims?.credentials, [`project-${project.toLowerCase()}`]);
    const prompt = await built.app.turn({ ...request, text: "!sysprompt" });
    assert.match(prompt.reply ?? "", new RegExp(`project-${project.toLowerCase()}`));
    assert.doesNotMatch(prompt.reply ?? "", new RegExp(`project-${project === "A" ? "b" : "a"}`));
  }
  const result = await built.app.turn(dm("!run echo hi"));
  assert.equal(result.status, "ok", result.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined);
  const prompt = await built.app.turn(dm("!sysprompt"));
  assert.doesNotMatch(prompt.reply ?? "", /Shared org credentials available to you|project-a|project-b/);
  assert.deepEqual(
    (await built.acl.list())
      .filter((grant) => grant.ref.startsWith("service-cred:"))
      .map((grant) => grant.granteeScopeId)
      .sort(),
    ["group:A", "group:B"],
  );
});

test("workgroup broker HTTP calls recheck current membership and credential availability", async () => {
  const { built, config, env } = buildWithCapture();
  await built.app.upsertDirectory([
    { principalId: "U1", displayName: "Member One", type: "internal" },
    { principalId: "U2", displayName: "Member Two", type: "internal" },
  ]);
  await built.directory.upsertGroup("A", ["U1", "U2"]);
  await built.directory.upsertGroup("B", ["U2"]);
  for (const project of ["A", "B"]) {
    const slug = `project-${project.toLowerCase()}`;
    await built.serviceCreds.setServiceCredential("org:default-org", {
      slug,
      name: project,
      secret: `dummy-${slug}-secret`,
      host: "upstream.example",
    });
    await built.acl.grant({
      ownerScopeId: "org:default-org",
      ref: `service-cred:${slug}`,
      granteeScopeId: `group:${project}`,
      permission: "read",
      grantedBy: "admin",
    });
  }
  const mintedAfter = Date.now();
  const request: TurnRequest = {
    ...dm("!run echo hi"),
    surface: "web",
    origin: { kind: "direct" },
    conversation: {
      kind: "group",
      channelRef: "A",
      threadRef: "grp:A:http",
      audience: [internalActor, { externalId: "U2" }],
    },
  };
  const result = await built.app.turn(request);
  assert.equal(result.status, "ok", result.reason);
  const mintedBefore = Date.now();
  const token = env()?.AGENT_CREDENTIAL_TOKEN;
  const controlToken = env()?.AGENT_API_TOKEN;
  assert.ok(token);
  assert.ok(controlToken);
  const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
  assert.ok(claims);
  assert.equal(claims.actorId, "U1");
  assert.equal(claims.scopeId, "group:A");
  assert.equal(claims.aud, CREDENTIAL_BROKER_AUD);
  assert.equal(claims.liveActor, undefined);
  assert.deepEqual(claims.credentials, ["project-a"]);
  assert.ok(claims.exp >= mintedAfter + CAPABILITY_TTL_MS);
  assert.ok(claims.exp <= mintedBefore + CAPABILITY_TTL_MS);
  assert.equal(await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET, claims.exp), null);
  const upstreamCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    brokerFetch: async (url, init) => {
      upstreamCalls.push({ url, headers: init.headers });
      return { status: 200, contentType: "application/json", text: async () => '{"course":"A"}' };
    },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = (body: object = {}, capability = token) =>
    fetch(`${base}/v1/credentials/broker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": capability },
      body: JSON.stringify({ credential: "project-a", url: "https://upstream.example/course", ...body }),
    });
  try {
    const allowed = await call();
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), {
      status: 200,
      contentType: "application/json",
      body: '{"course":"A"}',
    });
    assert.deepEqual(upstreamCalls, [
      {
        url: "https://upstream.example/course",
        headers: { Authorization: "Bearer dummy-project-a-secret" },
      },
    ]);
    const expanded = await call({ credential: "project-b", scopeId: "group:B", credentials: ["project-b"] });
    assert.equal(expanded.status, 403);
    assert.equal(((await expanded.json()) as { error: string }).error, "not_entitled");
    const bodyScope = await call({ scopeId: "group:B" });
    assert.equal(bodyScope.status, 200);
    assert.equal(((await bodyScope.json()) as { body: string }).body, '{"course":"A"}');
    assert.equal((await call({}, controlToken)).status, 403);
    const expired = await mintCapabilityToken({ ...claims, exp: Date.now() - 1 }, TEST_CAPABILITY_SECRET);
    assert.equal((await call({}, expired)).status, 401);
    assert.equal(upstreamCalls.length, 2);

    await built.directory.upsertGroup("A", ["U2"]);
    const removed = await call({ scopeId: "group:B" });
    assert.equal(removed.status, 403);
    assert.match(await removed.text(), /scope membership has been revoked/);
    const removedTurn = await built.app.turn(request);
    assert.equal(removedTurn.status, "refused");

    await built.directory.upsertGroup("A", ["U1", "U2"]);
    await built.serviceCreds.setServiceCredential("org:default-org", {
      slug: "project-a",
      name: "A",
      host: "upstream.example",
      enabled: false,
    });
    const disabled = await call();
    assert.equal(disabled.status, 404);
    assert.equal(((await disabled.json()) as { error: string }).error, "credential_unavailable");

    await built.app.upsertDirectory([{ principalId: "U2", displayName: "Member Two", type: "internal" }]);
    const inactive = await call();
    assert.equal(inactive.status, 401);
    assert.match(await inactive.text(), /principal is no longer active/);
    assert.equal((await built.app.turn(request)).status, "refused");
    assert.equal(upstreamCalls.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("granted broker credentials work across turn origins while env delivery retains its audience gate", async () => {
  const { built, env } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "shared",
    name: "Shared",
    secret: "s",
    host: "h.example",
  });
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "env-shared",
    name: "Env",
    secret: "env-value",
    delivery: "env",
    envKey: "SHARED_ENV",
    host: "",
  });
  for (const slug of ["shared", "env-shared"]) {
    await built.acl.grant({
      ownerScopeId: "org:default-org",
      ref: `service-cred:${slug}`,
      granteeScopeId: "org:default-org",
      permission: "read",
      grantedBy: "admin",
    });
  }
  const guest = { externalId: "guest", isExternalGuest: true };
  const requests: TurnRequest[] = [
    ...(["human", "direct", "automation", "ambient"] as const).map((kind) => ({
      ...dm("!run echo hi"),
      origin: { kind },
      ...(["automation", "ambient"].includes(kind) ? { liveActor: true } : {}),
    })),
    {
      ...dm("!run echo hi"),
      conversation: {
        kind: "group" as const,
        threadRef: "grp:A:no-publish-members",
        channelRef: "A",
        audience: [internalActor],
      },
    },
    {
      ...dm("!run echo hi"),
      conversation: {
        kind: "channel" as const,
        threadRef: "ch:C1:guest",
        channelRef: "C1",
        audience: [internalActor],
        publishMembers: [internalActor, guest],
      },
    },
  ];
  for (const request of requests) {
    const result = await built.app.turn(request);
    assert.equal(result.status, "ok", result.reason);
    const token = env()?.AGENT_CREDENTIAL_TOKEN;
    assert.ok(token, JSON.stringify(request.origin));
    const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
    assert.deepEqual(claims?.credentials, ["shared"]);
    assert.equal(env()?.SHARED_ENV, request.conversation.kind === "dm" ? "env-value" : undefined);
    const prompt = await built.app.turn({ ...request, text: "!sysprompt" });
    assert.match(prompt.reply ?? "", /Shared org credentials available to you/);
    assert.match(prompt.reply ?? "", /AGENT_CREDENTIAL_TOKEN/);
  }
  const beforeRefusal = env();
  const refused = await built.app.turn({
    ...dm("!sysprompt"),
    conversation: {
      kind: "channel",
      threadRef: "ch:C1:external-audience",
      channelRef: "C1",
      audience: [internalActor, guest],
      publishMembers: [internalActor],
    },
  });
  assert.equal(refused.status, "refused");
  assert.equal(env(), beforeRefusal);
  assert.doesNotMatch(refused.reply ?? "", /Shared org credentials available to you|AGENT_CREDENTIAL_TOKEN/);
  const guestRefused = await built.app.turn({ ...dm("!run echo hi"), actor: guest });
  assert.equal(guestRefused.status, "refused");
  assert.match(guestRefused.reason ?? "", /non-internal principals/);
  assert.equal(env(), beforeRefusal);
});

test("orchestrator stamps nothing when the org has no service credentials (zero-cost common path)", async () => {
  const { built, env } = buildWithCapture();
  const res = await built.app.turn(dm("!run echo hi"));
  assert.equal(res.status, "ok", res.reason);
  assert.equal(env()?.AGENT_CREDENTIAL_TOKEN, undefined);
  assert.ok(env()?.AGENT_API_TOKEN, "control-plane token should still be present");
});

test("the system prompt advertises an entitled credential (host/methods/paths) so the agent can use the broker", async () => {
  const { built } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X firehose",
    secret: "s",
    host: "api.x.com",
    allowedMethods: ["GET"],
    allowedPathPrefixes: ["/2/tweets/search/"],
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "org:default-org",
    permission: "read",
    grantedBy: "admin",
  });
  const res = await built.app.turn(dm("!sysprompt"));
  const reply = res.reply ?? "";
  assert.match(reply, /Shared org credentials available to you/);
  assert.match(reply, /\/v1\/credentials\/broker/);
  assert.match(reply, /x-agent-capability: \$AGENT_CREDENTIAL_TOKEN/);
  assert.match(reply, /x-firehose.*api\.x\.com.*GET.*\/2\/tweets\/search\//s);
});

test("the system prompt does NOT advertise a credential the session isn't entitled to", async () => {
  const { built } = buildWithCapture();
  await built.serviceCreds.setServiceCredential("org:default-org", {
    slug: "x-firehose",
    name: "X firehose",
    secret: "s",
    host: "api.x.com",
  });
  await built.acl.grant({
    ownerScopeId: "org:default-org",
    ref: "service-cred:x-firehose",
    granteeScopeId: "personal:U2",
    permission: "read",
    grantedBy: "admin",
  });
  const res = await built.app.turn(dm("!sysprompt"));
  assert.doesNotMatch(res.reply ?? "", /Shared org credentials available to you/);
});

test("the published-apps switch defaults on, round-trips, survives a partial update, and rejects non-booleans", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "yc-data", name: "YC data", secret: "s", host: "relay.example" });
    let loaded = (await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "yc-data")!;
    assert.equal(loaded.deployments, true);
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "yc-data",
          name: "YC data",
          host: "relay.example",
          deployments: false,
          expectedUpdatedAt: loaded.updatedAt,
        })
      ).status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "yc-data")!;
    assert.equal(loaded.deployments, false);
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "yc-data",
          name: "YC data renamed",
          host: "relay.example",
          expectedUpdatedAt: loaded.updatedAt,
        })
      ).status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "yc-data")!;
    assert.equal(loaded.deployments, false, "a partial update keeps the switch as it was");
    const bad = await putCred(srv.base, {
      slug: "yc-data",
      name: "YC data",
      host: "relay.example",
      deployments: "no",
      expectedUpdatedAt: loaded.updatedAt,
    });
    assert.equal(bad.status, 400);
  } finally {
    await srv.close();
  }
});
