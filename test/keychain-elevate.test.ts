import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { keychainRoutes } from "../src/api/routes/keychain.ts";
import { composioRoutes } from "../src/api/routes/composio.ts";
import type { ApiCtx, Route } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { orgId } from "../src/config.ts";

const ORG = scopeId("org", orgId());
const TEAMS: Record<string, string[]> = { labs: ["alice", "bob"], other: ["carol"] };

function fixture(admins: string[] = []) {
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("keychain-elevate-test"),
  });
  const acl = createAclStore();
  const audits: AuditEvent[] = [];
  const keys: string[] = [];
  const deps = {
    keychain,
    serviceCreds: keychain,
    acl,
    auditLog: { record: (e: AuditEvent) => audits.push(e) },
    admin: { adminStatusOf: async (p: { id: string }) => ({ isAdmin: admins.includes(p.id) }) },
    teams: {
      isMember: async (principal: string, team: string) => TEAMS[team]?.includes(principal) ?? false,
      forTurn: async (_scope: string, ids: readonly string[]) =>
        Object.entries(TEAMS)
          .filter(([, members]) => ids.some((id) => members.includes(id)))
          .map(([id, members]) => ({
            id,
            name: id,
            isolatedInOpen: false,
            configured: false,
            present: new Set(members),
          })),
    },
    composioFetch: (async (_url: string, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("x-api-key") ?? "");
      return Response.json({ items: [], next_cursor: null });
    }) as typeof fetch,
  } as unknown as ServerDeps;

  async function call(routes: ReadonlyArray<Route<ApiCtx>>, path: string, ctx: Partial<ApiCtx>) {
    let status = 0;
    let text = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        text = value;
      },
    } as unknown as ServerResponse;
    const url = new URL(path, "http://localhost");
    const route = routes.find((r) => "path" in r && r.method === (ctx.method ?? "GET") && r.path === ctx.pathname)!;
    await route.handle({ deps, res, url, pathname: url.pathname, ...ctx } as ApiCtx);
    return { status, data: JSON.parse(text) };
  }

  const cap = (actorId: string, over: Partial<CapabilityClaims> = {}): CapabilityClaims => ({
    actorId,
    scopeId: scopeId("personal", actorId),
    liveActor: true,
    exp: Date.now() + 60_000,
    ...over,
  });

  const elevate = (id: string, body: unknown, capability: CapabilityClaims) =>
    call(keychainRoutes, `/v1/keychain/credentials/${id}/elevate`, {
      method: "POST",
      pathname: "/v1/keychain/credentials/:id/elevate",
      params: { id },
      body,
      capability,
    });

  const toolkits = (actor: string) =>
    call(composioRoutes, "/v1/composio/toolkits", {
      method: "GET",
      pathname: "/v1/composio/toolkits",
      capability: null,
      actor: { p: actor, exp: Date.now() + 60_000 },
    });

  const saveKey = (ownerId = "alice") =>
    keychain.save({ ownerId, service: "composio", envKey: "COMPOSIO_API_KEY", secret: `${ownerId}-project-key` });

  return { keychain, acl, audits, keys, elevate, toolkits, saveKey, cap };
}

test("a team member's Composio key reaches teammates through the backend, never anyone else", async () => {
  const f = fixture();
  const cred = await f.saveKey();
  assert.equal((await f.toolkits("bob")).status, 403);

  const r = await f.elevate(cred.id, { toScope: "team:labs" }, f.cap("alice"));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {
    serviceCredential: { slug: "composio-team-labs", grantee: "team:labs" },
    removedPersonalCopy: false,
  });
  assert.doesNotMatch(JSON.stringify(r.data), /project-key/);

  assert.equal((await f.toolkits("bob")).status, 200);
  assert.equal(f.keys.at(-1), "alice-project-key");
  assert.equal((await f.toolkits("carol")).status, 403);
  assert.ok((await f.keychain.listByOwner("alice")).length === 1, "the personal copy stays unless asked");

  const actions = f.audits.map((e) => `${e.action} ${e.scopeLabel}`);
  assert.ok(actions.includes("keychain.elevate team:labs"));
  assert.ok(actions.includes("service_credential.share team:labs"));
  assert.doesNotMatch(JSON.stringify(f.audits), /project-key/);
});

test("elevation requires the owner, live in their own conversation, on the target team", async () => {
  const f = fixture();
  const cred = await f.saveKey();
  const refused: Array<[CapabilityClaims, unknown, number]> = [
    [f.cap("bob"), { toScope: "team:labs" }, 404],
    [f.cap("alice"), { toScope: "team:other" }, 403],
    [f.cap("alice"), { toScope: "org" }, 403],
    [f.cap("alice"), { toScope: "channel:C1" }, 400],
    [f.cap("alice"), { toScope: "team:labs", removePersonalCopy: "yes" }, 400],
    [f.cap("alice", { scopeId: "channel:C1" }), { toScope: "team:labs" }, 403],
    [f.cap("alice", { liveActor: false }), { toScope: "team:labs" }, 403],
    [f.cap("alice", { triggered: true }), { toScope: "team:labs" }, 403],
  ];
  for (const [capability, body, status] of refused)
    assert.equal((await f.elevate(cred.id, body, capability)).status, status, JSON.stringify([capability, body]));
  assert.deepEqual(await f.keychain.listServiceCredentials(ORG), []);

  const github = await f.keychain.save({ ownerId: "alice", service: "github", envKey: "GITHUB_TOKEN", secret: "gh" });
  assert.equal((await f.elevate(github.id, { toScope: "team:labs" }, f.cap("alice"))).status, 409);
});

test("org elevation is admin-only and refuses a second Composio key for the same audience", async () => {
  const f = fixture(["alice"]);
  const cred = await f.saveKey();
  const r = await f.elevate(cred.id, { toScope: "org", removePersonalCopy: true }, f.cap("alice"));
  assert.equal(r.status, 200);
  assert.equal(r.data.serviceCredential.grantee, ORG);
  assert.equal(r.data.removedPersonalCopy, true);
  assert.deepEqual(await f.keychain.listByOwner("alice"), []);
  assert.equal((await f.toolkits("carol")).status, 200);

  const bob = await f.saveKey("bob");
  assert.equal((await f.elevate(bob.id, { toScope: "team:labs" }, f.cap("bob"))).status, 409);
  assert.equal((await f.keychain.listServiceCredentials(ORG)).length, 1);
});
