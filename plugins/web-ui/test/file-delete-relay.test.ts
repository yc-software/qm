import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

interface Call {
  method: string;
  url: string;
  body: string;
  portalIdentity?: string;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const pid = req.headers["x-portal-identity"];
    const url = req.url ?? "";
    calls.push({
      method: req.method ?? "GET",
      url,
      body: raw,
      portalIdentity: Array.isArray(pid) ? pid[0] : pid,
    });
    const pathname = new URL(url, "http://core").pathname;
    if (pathname === "/v1/files/forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "forbidden", message: "that file isn't yours to delete" }));
    }
    if (pathname === "/v1/files/ghost") {
      res.writeHead(404, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "not_found", message: "no such file" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "file-delete-relay-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = { cookie: "webuiuser=alice", "x-portal-identity": "tok-delete" };

test.after(() => {
  surface.close();
  core.close();
});

function fileCalls(from: number): Call[] {
  return calls.slice(from).filter((c) => new URL(c.url, "http://core").pathname.startsWith("/v1/files/"));
}

test("a delete relays one signed core call whose principal comes only from the session", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/files/f1`, { method: "DELETE", headers });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });

  const relayed = fileCalls(before);
  assert.equal(relayed.length, 1, "one browser delete is exactly one core delete");
  const call = relayed[0]!;
  assert.equal(call.method, "DELETE");
  const url = new URL(call.url, "http://core");
  assert.equal(url.pathname, "/v1/files/f1");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["_sourceAuthNonce", "principalId"]);
  assert.equal(url.searchParams.get("principalId"), "alice");
  assert.ok((url.searchParams.get("_sourceAuthNonce") ?? "").length > 0);
  assert.equal(call.portalIdentity, "tok-delete", "core's portal-identity gate needs the forwarded token");
});

test("a client-supplied principalId in the query or body is never relayed", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/files/f1?principalId=mallory`, {
    method: "DELETE",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ principalId: "mallory" }),
  });
  assert.equal(r.status, 200);

  const relayed = fileCalls(before);
  assert.equal(relayed.length, 1);
  const url = new URL(relayed[0]!.url, "http://core");
  assert.deepEqual(url.searchParams.getAll("principalId"), ["alice"]);
  assert.equal(relayed[0]!.body, "", "the surface forwards no body, so no body field can be trusted downstream");
});

test("an unauthenticated delete is refused at the surface and never reaches core", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/files/f1`, { method: "DELETE" });
  assert.equal(r.status, 401);
  assert.equal(fileCalls(before).length, 0);
});

test("core's refusals relay verbatim so the page can show the real reason", async () => {
  for (const [id, status, message] of [
    ["forbidden", 403, "that file isn't yours to delete"],
    ["ghost", 404, "no such file"],
  ] as const) {
    const r = await fetch(`${base}/api/files/${id}`, { method: "DELETE", headers });
    assert.equal(r.status, status);
    assert.equal(((await r.json()) as { message?: string }).message, message);
  }
});

test("an id needing escaping is encoded exactly once and cannot walk out of /v1/files/", async () => {
  const before = calls.length;
  await fetch(`${base}/api/files/${encodeURIComponent("../uploads/x")}`, { method: "DELETE", headers });

  const relayed = fileCalls(before);
  assert.equal(relayed.length, 1);
  const url = new URL(relayed[0]!.url, "http://core");
  assert.equal(url.pathname, `/v1/files/${encodeURIComponent("../uploads/x")}`);
  assert.equal(url.pathname.split("/").length, 4, "the id stays one path segment");
});
