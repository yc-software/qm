import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { mintCapabilityToken, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import { findRoute } from "../src/api/routes/route.ts";
import { userScopedField } from "../src/api/user-scoped-routes.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";

const CAP = "core-only-capability-secret-for-delete-01";
const PID = "portal-only-identity-secret-for-delete-01";

const outcomes = new Map<string, "deleted" | "forbidden" | "not_found">([
  ["mine", "deleted"],
  ["theirs", "forbidden"],
  ["ghost", "not_found"],
]);
const attempts: Array<{ id: string; principalId: string }> = [];

let built: BuiltApp;
const servers: Server[] = [];
let open: string;
let gated: string;
let actorFirst: string;

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, () => resolve(`http://localhost:${(server.address() as AddressInfo).port}`)),
  );
}

const token = (p: string) => mintSignedPayload({ p, exp: Date.now() + 60_000 }, PID);

before(async () => {
  built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "file-delete-route-")) }));
  built.app.authorizesCapabilityScope = async () => true;
  built.app.deleteFileForViewer = async (id, principalId) => {
    attempts.push({ id, principalId });
    return outcomes.get(id) ?? "not_found";
  };
  open = await listen(createInsecureTestServer(built.app, {}));
  gated = await listen(
    createInsecureTestServer(built.app, {
      capabilitySecret: CAP,
      portalIdentitySecret: PID,
      requireSignedPortalIdentity: true,
      identity: built.identity,
    }),
  );
  actorFirst = await listen(
    createInsecureTestServer(built.app, { portalIdentitySecret: PID, identity: built.identity }),
  );
});

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const del = (base: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("a delete that names no principal is a bad request, and a body principalId does not count", async () => {
  const before = attempts.length;
  const bare = await del(open, "/v1/files/mine");
  assert.equal(bare.status, 400);
  assert.deepEqual(await bare.json(), { error: "bad_request", message: "principalId required" });

  const bodyOnly = await del(open, "/v1/files/mine", {}, { principalId: "U1" });
  assert.equal(bodyOnly.status, 400, "the handler reads the query, the same location USER_SCOPED declares");
  assert.equal(attempts.length, before, "an unauthenticated delete never reaches the app");
  assert.deepEqual(userScopedField("DELETE", "/v1/files/mine"), { in: "query", name: "principalId" });
});

test("the three app outcomes map to 200, 403 and 404", async () => {
  const ok = await del(open, "/v1/files/mine?principalId=U1");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  const refused = await del(open, "/v1/files/theirs?principalId=U1");
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "forbidden", message: "that file isn't yours to delete" });

  const missing = await del(open, "/v1/files/ghost?principalId=U1");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found", message: "no such file" });
});

test("an agent capability token cannot reach this route (it is source-authenticated only)", async () => {
  const before = attempts.length;
  const cap = await mintCapabilityToken(
    { actorId: "U1", scopeId: scopeId("personal", "U1"), aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 },
    CAP,
  );
  const r = await del(gated, "/v1/files/mine?principalId=U1", { "x-agent-capability": cap });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { message?: string }).message, "capability token not valid for this route");
  assert.equal(attempts.length, before);
});

test("with enforcement on, the portal identity must be present and must match the named principal", async () => {
  const before = attempts.length;
  const anonymous = await del(gated, "/v1/files/mine?principalId=U1");
  assert.equal(anonymous.status, 401);
  assert.equal(((await anonymous.json()) as { message?: string }).message, "portal identity required");

  const impostor = await del(gated, "/v1/files/mine?principalId=U2", { "x-portal-identity": await token("U1") });
  assert.equal(impostor.status, 403);
  assert.equal(
    ((await impostor.json()) as { message?: string }).message,
    "portal identity does not match the requested actor",
  );
  assert.equal(attempts.length, before, "the gate answers before the app is asked to delete anything");

  const mine = await del(gated, "/v1/files/mine?principalId=U1", { "x-portal-identity": await token("U1") });
  assert.equal(mine.status, 200);
  assert.deepEqual(attempts.at(-1), { id: "mine", principalId: "U1" });
});

test("with enforcement off, a verified actor still wins over a query principal it disagrees with", async () => {
  const r = await del(actorFirst, "/v1/files/mine?principalId=U2", { "x-portal-identity": await token("U1") });
  assert.equal(r.status, 200);
  assert.deepEqual(
    attempts.at(-1),
    { id: "mine", principalId: "U1" },
    "a source-auth caller must not be able to delete as somebody else",
  );
});

test("the direct-upload abort route keeps its own handler; /v1/files/:id cannot shadow it", () => {
  const upload = findRoute(apiRoutes, "DELETE", "/v1/files/uploads/abc123");
  assert.equal(upload && "path" in upload.route ? upload.route.path : null, "/v1/files/uploads/:id");
  const artifact = findRoute(apiRoutes, "DELETE", "/v1/files/abc123");
  assert.equal(artifact && "path" in artifact.route ? artifact.route.path : null, "/v1/files/:id");
});
