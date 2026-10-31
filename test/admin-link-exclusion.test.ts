import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminError, createAdminService } from "../src/admin/admin-service.ts";
import { createAdminGrantStore, type AdminGrant } from "../src/admin/admin-grant-store.ts";
import { orgId } from "../src/config.ts";
import { PrincipalLinkError } from "../src/identity/principal-links.ts";
import type { PrincipalLink } from "../src/identity/principal-links.ts";
import { type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { testPrincipalLinks } from "./support/principal-links.ts";
import { testMap, testAdminGrantStore } from "./support/test-database.ts";

const ROOT = "root@acme.test";
const ISSUER = "https://issuer.test";
const ORG = scopeId("org", orgId());
const root: AdminGrant = { principalId: ROOT, scopeId: ORG, role: "org_admin" };
const actor = { id: ROOT, type: "internal" as const };
const evidence = "verified in test";

function deferred() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

function setup(
  wrap?: (store: ReturnType<typeof createAdminGrantStore>) => ReturnType<typeof createAdminGrantStore>,
  wrapLinks?: (backing: DurableMap<PrincipalLink>) => DurableMap<PrincipalLink>,
) {
  const raw = testAdminGrantStore([root]);
  const store = wrap ? wrap(raw) : raw;
  const backing = testMap<PrincipalLink>();
  const links = testPrincipalLinks(wrapLinks ? wrapLinks(backing) : backing, store);
  const admin = createAdminService(store, { principalLinks: links, trustedOidcAdminIssuer: ISSUER });
  const grantRows = async (id: string) => (await raw.list()).filter((g) => g.principalId === id);
  return { raw, links, admin, grantRows };
}

const grantFor = (principalId: string) => ({ principalId, role: "org_admin" as const, scopeId: ORG });

test("a plain link and a plain grant both succeed", async () => {
  const s = setup();
  await s.links.link({ principalId: "alias@acme.test", canonicalId: "canon@acme.test", evidence, linkedBy: ROOT });
  await s.admin.createGrant(actor, grantFor("other@acme.test"));
  assert.equal((await s.links.list()).length, 1);
  assert.equal((await s.grantRows("other@acme.test")).length, 1);
});

test("link refuses an alias that holds its own admin grant, folded and exact", async () => {
  const s = setup();
  await s.admin.createGrant(actor, grantFor("alice@x.com"));
  for (const alias of ["alice@x.com", "Alice@X.com"]) {
    await assert.rejects(
      s.links.link({ principalId: alias, canonicalId: "canon@acme.test", evidence, linkedBy: ROOT }),
      (e: unknown) => e instanceof PrincipalLinkError && e.status === 409,
    );
  }
  assert.deepEqual(await s.links.list(), []);
  assert.equal((await s.grantRows("alice@x.com")).length, 1);
});

test("createGrant refuses an existing alias and trusted provisioning writes nothing for one", async () => {
  const s = setup();
  await s.links.link({ principalId: "Alice@X.com", canonicalId: "canon@acme.test", evidence, linkedBy: ROOT });
  await assert.rejects(
    s.admin.createGrant(actor, grantFor("alice@x.com")),
    (e: unknown) => e instanceof AdminError && e.status === 409,
  );
  const oidcAlias = `oidc:${(await import("node:crypto")).createHash("sha256").update(ISSUER).digest("hex")}:${Buffer.from("sub").toString("base64url")}`;
  await s.links.link({ principalId: oidcAlias, canonicalId: "canon@acme.test", evidence, linkedBy: ROOT });
  assert.equal((await s.admin.provisionTrustedEntry(ISSUER, "sub")).created, false);
  assert.deepEqual(
    (await s.raw.list()).map((g) => g.principalId),
    [ROOT],
  );
});

test("link racing a grant on the same alias never leaves both, link first", async () => {
  const hold = deferred();
  const s = setup(undefined, (raw) => ({
    ...raw,
    putIfAbsent: async (k, v) => (await hold.gate, raw.putIfAbsent(k, v)),
  }));
  const link = s.links.link({ principalId: "a@acme.test", canonicalId: "c@acme.test", evidence, linkedBy: ROOT });
  await new Promise((resolve) => setImmediate(resolve));
  const grant = s.admin.createGrant(actor, grantFor("a@acme.test"));
  await new Promise((resolve) => setImmediate(resolve));
  hold.open();
  const settled = await Promise.allSettled([link, grant]);
  const linked = (await s.links.list()).some((l) => l.principalId === "a@acme.test");
  const granted = (await s.grantRows("a@acme.test")).length > 0;
  assert.equal(linked !== granted, true, `link=${linked} grant=${granted} ${settled.map((r) => r.status)}`);
});

test("link racing a grant on the same alias never leaves both, grant first", async () => {
  const hold = deferred();
  const s = setup((raw) => ({ ...raw, add: async (g) => (await hold.gate, raw.add(g)) }));
  const grant = s.admin.createGrant(actor, grantFor("a@acme.test"));
  await new Promise((resolve) => setImmediate(resolve));
  const link = s.links.link({ principalId: "a@acme.test", canonicalId: "c@acme.test", evidence, linkedBy: ROOT });
  await new Promise((resolve) => setImmediate(resolve));
  hold.open();
  await Promise.allSettled([grant, link]);
  const linked = (await s.links.list()).some((l) => l.principalId === "a@acme.test");
  const granted = (await s.grantRows("a@acme.test")).length > 0;
  assert.equal(linked !== granted, true, `link=${linked} grant=${granted}`);
});

test("a mixed-case grant target is refused when the alias was linked in lower case", async () => {
  const s = setup();
  await s.links.link({ principalId: "alice@x.com", canonicalId: "canon@acme.test", evidence, linkedBy: ROOT });
  await assert.rejects(
    s.admin.createGrant(actor, grantFor("Alice@X.com")),
    (e: unknown) => e instanceof AdminError && e.status === 409,
  );
  assert.deepEqual(
    (await s.raw.list()).map((g) => g.principalId),
    [ROOT],
  );
});
