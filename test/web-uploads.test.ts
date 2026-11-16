import "./support/auto-fake-sprites.ts";
import type { Tenant } from "../src/tenants/context.ts";

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { BlobTooLargeError, type BlobInfo } from "../src/persistence/blob-transfer.ts";

const SIGNING = "web-uploads-signing-secret-0123456789";

type Deps = ReturnType<typeof serverDeps>;

async function core(t: TestContext, overrides: (deps: Deps) => Partial<Deps> = () => ({})) {
  const config = testConfig({ signingSecret: SIGNING });
  const built = stopAtEnd(buildApp(config));
  const deps = serverDeps(config, built);
  const server = createServer(built.app, { ...deps, ...browserSessionDeps, ...overrides(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, built, transferDir: join(config.dataDir, "transfer") };
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const tap = <T>(seen: PromiseWithResolvers<T>, put: Promise<T>) => (seen.resolve(put), put);

const upload = (base: string, path: string, cookie: string, body: Buffer, contentType = "text/plain") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, origin: browserSessionDeps.portalUrl, "content-type": contentType },
    body,
  });

test("a browser blob streams past the 1 MB JSON cap, is checked against its declared sha and answers the relay's shapes", async (t) => {
  const { base, built } = await core(t);
  const alice = browserSessionCookie("alice");
  const bytes = Buffer.alloc(3 * 1024 * 1024, 7);
  const staged = await upload(base, `/api/blobs?sha=${sha(bytes)}`, alice, bytes, "application/octet-stream");
  assert.equal(staged.status, 200);
  const { blobId, sizeBytes } = (await staged.json()) as { blobId: string; sizeBytes: number };
  assert.equal(sizeBytes, bytes.length);
  assert.equal((await built.blobTransfer.open(blobId))?.sizeBytes, bytes.length);

  for (const query of ["", "?sha=abc", `?sha=${sha(bytes).toUpperCase()}`]) {
    const refused = await upload(base, `/api/blobs${query}`, alice, bytes);
    assert.deepEqual(
      [refused.status, await refused.json()],
      [400, { error: "bad_request", message: "sha (hex sha-256) required" }],
    );
  }
  const mismatch = await upload(base, `/api/blobs?sha=${sha(Buffer.from("other"))}`, alice, bytes);
  assert.deepEqual(
    [mismatch.status, await mismatch.json()],
    [400, { error: "hash_mismatch", message: "blob content hash mismatch" }],
  );
  const anonymous = await fetch(`${base}/api/blobs?sha=${sha(bytes)}`, { method: "POST", body: bytes });
  assert.equal(anonymous.status, 401);
});

test("a file upload lands in the signed-in person's files with its name and content type", async (t) => {
  const { base } = await core(t);
  const bytes = Buffer.from("hello, file");
  const query = new URLSearchParams({ sha: sha(bytes), name: " notes é.txt " });
  const uploaded = await upload(base, `/api/files/upload?${query}`, browserSessionCookie("alice"), bytes);
  assert.equal(uploaded.status, 200);
  const { file } = (await uploaded.json()) as { file: { id: string; name: string; mimetype: string } };
  assert.deepEqual([file.name, file.mimetype], ["notes é.txt", "text/plain"]);
  const stored = await fetch(`${base}/api/files/${file.id}/content`, {
    headers: { cookie: browserSessionCookie("alice") },
  });
  assert.equal(await stored.text(), "hello, file");
  const bobs = await fetch(`${base}/api/files`, { headers: { cookie: browserSessionCookie("bob") } });
  assert.ok(!(await bobs.text()).includes(file.id));
  const named = await upload(base, `/api/files/upload?${query}&principalId=bob`, browserSessionCookie("alice"), bytes);
  assert.equal(named.status, 403);
  const elsewhere = new URLSearchParams({ sha: sha(bytes), scope: "personal:bob" });
  const foreign = await upload(base, `/api/files/upload?${elsewhere}`, browserSessionCookie("alice"), bytes);
  assert.deepEqual(
    [foreign.status, await foreign.json()],
    [403, { error: "forbidden", message: "you can only upload to your own contexts" }],
  );
});

test("an admin upload streams into the scope's files and refuses non-admins, impersonation and a missing scope", async (t) => {
  const { base } = await core(t);
  const bytes = Buffer.from("admin notes");
  const query = new URLSearchParams({ scope: "org:default-org", sha: sha(bytes), name: "policy.txt" });
  const admin = browserSessionCookie("admin-alice");
  const uploaded = await upload(base, `/api/admin/files/upload?${query}`, admin, bytes);
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const { file } = (await uploaded.json()) as {
    file: { name: string; mimetype: string; scopeId: string; size: number };
  };
  assert.deepEqual(
    [file.name, file.mimetype, file.scopeId, file.size],
    ["policy.txt", "text/plain", "org:default-org", bytes.length],
  );
  const missing = await upload(base, `/api/admin/files/upload?sha=${sha(bytes)}`, admin, bytes);
  assert.deepEqual([missing.status, ((await missing.json()) as { message: string }).message], [400, "scope required"]);
  assert.equal(
    (await upload(base, `/api/admin/files/upload?${query}`, browserSessionCookie("carol"), bytes)).status,
    403,
  );
  const impersonating = `${admin}; ${browserImpersonationCookie("admin-alice", "admin-bob")}`;
  const refused = await upload(base, `/api/admin/files/upload?${query}`, impersonating, bytes);
  assert.deepEqual(
    [refused.status, await refused.json()],
    [403, { error: "forbidden", message: "Unavailable while impersonating." }],
  );
});

test("an upload the browser abandons midway leaves no partial blob and the server keeps serving", async (t) => {
  const staged = Promise.withResolvers<BlobInfo>();
  const { base, port, transferDir } = await core(t, ({ blobTransfer }) => ({
    blobTransfer: { ...blobTransfer!, put: (...args) => tap(staged, blobTransfer!.put(...args)) },
  }));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 1);
  const req = request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: `/api/blobs?sha=${sha(bytes)}`,
    headers: {
      cookie: browserSessionCookie("alice"),
      origin: browserSessionDeps.portalUrl,
      "content-length": String(bytes.length),
    },
  });
  req.on("error", () => undefined);
  req.write(bytes.subarray(0, 512 * 1024), () => setTimeout(() => req.destroy(), 100));
  await assert.rejects(staged.promise);
  assert.deepEqual(await readdir(transferDir).catch(() => []), []);
  const small = Buffer.from("still here");
  const after = await upload(base, `/api/blobs?sha=${sha(small)}`, browserSessionCookie("alice"), small);
  assert.equal(after.status, 200);
});

test("signed callers keep staging through /v1/blobs and registering by blobId, and cannot use the browser upload routes", async (t) => {
  const { base } = await core(t);
  const bytes = Buffer.from("signed admin notes");
  const signed = (path: string, body: string | Buffer, tail: string, extra: Record<string, string> = {}) => {
    const nonced = withSourceAuthNonce(path, SIGNING);
    return fetch(`${base}${nonced}`, {
      method: "POST",
      headers: { ...signedHeaders(SIGNING, "POST", nonced, "", tail), ...extra },
      body,
    });
  };
  const browserBlob = await signed(`/v1/web/blobs?sha=${sha(bytes)}`, bytes, "");
  assert.equal(browserBlob.status, 401);
  const staged = await signed("/v1/blobs", bytes, sha(bytes), {
    "content-type": "application/octet-stream",
    "x-content-sha256": sha(bytes),
  });
  assert.equal(staged.status, 200);
  const { blobId } = (await staged.json()) as { blobId: string };
  const body = JSON.stringify({ blobId, name: "signed.txt", mimetype: "text/plain" });
  const registered = await signed("/v1/admin/files/upload?scope=org:default-org", body, body, {
    "x-admin-actor": "admin-alice@default-org",
  });
  assert.equal(registered.status, 200, await registered.clone().text());
  const { file } = (await registered.json()) as { file: { name: string; size: number } };
  assert.deepEqual([file.name, file.size], ["signed.txt", bytes.length]);
});

test("an upload past the size limit gets its 413 while the browser is still sending", async (t) => {
  const { port } = await core(t, () => ({
    blobTransfer: {
      put: async (source: AsyncIterable<Buffer>) => {
        let seen = 0;
        for await (const chunk of source) if ((seen += chunk.length) > 1024 * 1024) throw new BlobTooLargeError();
        throw new Error("the upload ended before the limit");
      },
    } as unknown as Deps["blobTransfer"],
  }));
  const chunk = Buffer.alloc(256 * 1024);
  const total = 256 * chunk.length;
  const answer = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/api/blobs?sha=${"0".repeat(64)}`,
        headers: {
          cookie: browserSessionCookie("alice"),
          origin: browserSessionDeps.portalUrl,
          "content-length": String(total),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (part) => (body += part));
        res.on("end", () => resolve(`${res.statusCode} ${body}`));
      },
    );
    req.on("error", reject);
    let sent = 0;
    const pump = () => {
      if (sent >= total) return req.end();
      sent += chunk.length;
      req.write(chunk, () => setTimeout(pump, 5));
    };
    pump();
  });
  assert.equal(answer, '413 {"error":"payload_too_large","message":"blob exceeds the size limit"}');
});

test("an admin upload dropped while its grant check is still running settles and leaves nothing staged", async (t) => {
  let dropped!: () => void;
  const clientGone = new Promise<void>((resolve) => (dropped = resolve));
  const staged = Promise.withResolvers<BlobInfo>();
  const { port, transferDir } = await core(t, (deps) => ({
    admin: Object.assign(Object.create(deps.admin!), {
      listGrants: async (tenant: Tenant) => {
        await clientGone;
        return deps.admin!.listGrants(tenant);
      },
    }),
    blobTransfer: {
      ...deps.blobTransfer!,
      put: (...args) => tap(staged, deps.blobTransfer!.put(...args)),
    },
  }));
  const bytes = Buffer.alloc(64 * 1024, 1);
  const req = request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: `/api/admin/files/upload?scope=org:default-org&sha=${sha(bytes)}`,
    headers: {
      cookie: browserSessionCookie("admin-alice"),
      origin: browserSessionDeps.portalUrl,
      "content-length": String(bytes.length * 4),
    },
  });
  req.on("error", () => undefined);
  req.write(bytes.subarray(0, 1024), () =>
    setTimeout(() => {
      req.destroy();
      setTimeout(dropped, 50);
    }, 50),
  );
  await assert.rejects(staged.promise);
  assert.deepEqual(await readdir(transferDir).catch(() => []), []);
});
