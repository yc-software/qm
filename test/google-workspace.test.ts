import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoogleWorkspaceService, GOOGLE_WORKSPACE_HOSTS } from "../src/connectors/google-workspace.ts";
import type { ConnectorTokenStore } from "../src/credentials/keychain.ts";
import { NeedsApproval } from "../src/tools/primitives.ts";

const file = (id = "file-1", name = "Quarterly report") => ({
  id,
  name,
  mimeType: "text/plain",
  modifiedTime: "2026-01-01T00:00:00Z",
  version: "1",
  parents: ["root"],
  trashed: false,
  capabilities: { canTrash: true },
});
function fixture() {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const accounts: Array<[string, string, string | undefined]> = [];
  const events: Array<{ action: string; resource: string; status: string }> = [];
  const grants = new Set<string>();
  let target = file();
  let children: unknown[] = [];
  const childFolders = new Map<string, unknown[]>();
  let patchStatus = 200;
  let etag = '"file-version-1"';
  let permissionId = "google-user-1";
  let incompleteSearch = false;
  let nextPageToken: string | undefined;
  let status = 200;
  const tokens = {
    connectorAccessToken: async (host: string, principal: string, account?: string) => {
      accounts.push([host, principal, account]);
      return "server-only-secret";
    },
  } as ConnectorTokenStore;
  const service = createGoogleWorkspaceService({
    principalId: "person-1",
    tokens,
    authorize: (command, key) => grants.delete(JSON.stringify([command, key])),
    audit: (e) => events.push(e),
    fetchImpl: (async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (init.method === "PATCH" && patchStatus !== 200)
        return new Response("write conflict", { status: patchStatus });
      if (status !== 200)
        return new Response("server-only-secret", { status, headers: { location: "https://attacker.test" } });
      let data: unknown = { ok: true };
      if (url.pathname === "/drive/v3/about") data = { user: { permissionId, emailAddress: "reader@example.test" } };
      else if (url.pathname === "/drive/v3/files" && init.method === "GET")
        data = {
          files: childFolders.get(url.searchParams.get("q")?.split("'")[1] ?? "") ?? children,
          incompleteSearch,
          nextPageToken,
        };
      else if (url.pathname === "/drive/v3/files/file-1" && init.method === "GET") data = target;
      return Response.json(data, { headers: { etag } });
    }) as typeof fetch,
  });
  return {
    service,
    calls,
    accounts,
    events,
    grants,
    target: (v: typeof target) => {
      target = v;
    },
    children: (v: unknown[], parent?: string) => {
      if (parent) childFolders.set(parent, v);
      else children = v;
    },
    etag: (v: string) => {
      etag = v;
    },
    patchStatus: (v: number) => {
      patchStatus = v;
    },
    identity: (v: string) => {
      permissionId = v;
    },
    incomplete: () => {
      incompleteSearch = true;
    },
    pagination: () => {
      nextPageToken = "repeated";
    },
    status: (v: number) => {
      status = v;
    },
  };
}
const request = (f: ReturnType<typeof fixture>, args: Record<string, unknown>) =>
  f.service.call("google_workspace_request", {
    service: "drive",
    method: "GET",
    path: "/drive/v3/files/file-1",
    ...args,
  });
async function approval(f: ReturnType<typeof fixture>, args: Record<string, unknown> = { fileId: "file-1" }) {
  try {
    await f.service.call("google_workspace_trash", args);
    assert.fail("expected approval");
  } catch (e) {
    assert.ok(e instanceof NeedsApproval);
    return e;
  }
}

test("reads use only the chosen person's server-held account and never return the token", async () => {
  const f = fixture();
  assert.match(await request(f, { accountType: "personal" }), /Quarterly report/);
  assert.deepEqual(f.accounts, [["www.googleapis.com", "person-1", "personal"]]);
  assert.equal(new Headers(f.calls[0]!.init.headers).get("authorization"), "Bearer server-only-secret");
  assert.equal(f.calls[0]!.init.redirect, "error");
  assert.ok(GOOGLE_WORKSPACE_HOSTS.includes("gmail.googleapis.com"));
});

for (const args of [
  { method: "DELETE" },
  { method: "POST", path: "/drive/v3/files/file-1/trash" },
  { method: "PATCH", body: { trashed: true } },
  { method: "PATCH", body: { permissions: [] } },
  { method: "PATCH", body: { name: "okay", trashed: false } },
  { path: "https://attacker.test/drive/v3/files/file-1" },
  { path: "/drive/v2/files/file-1" },
  { path: "/batch/drive/v3", method: "POST" },
  { path: "/drive/v3/files/../files/file-1" },
  { path: "/drive/v3/files/%66ile-1" },
  { path: "/drive/v3/files/file-1?alt=media" },
  { path: "/drive/v3/files/file-1/permissions", method: "POST", body: { role: "writer", type: "anyone" } },
  { headers: { "X-HTTP-Method-Override": "DELETE" } },
  { query: { access_token: "injected" } },
  { query: { $httpMethod: "DELETE" } },
  { query: { uploadType: "resumable" } },
  { body: { requests: [{ delete: true }] } },
  { approved: true },
  { accountType: "operator" },
])
  test(`rejects unsafe request ${JSON.stringify(args)}`, async () => {
    const f = fixture();
    await assert.rejects(request(f, args));
    assert.equal(f.calls.length, 0);
    assert.equal(f.accounts.length, 0);
    assert.equal(f.events.at(-1)?.status, "failed");
  });

test("edits and native content batch updates work without trash authorization", async () => {
  const f = fixture();
  await request(f, { method: "PATCH", body: { name: "New report" } });
  await request(f, {
    service: "docs",
    method: "POST",
    path: "/v1/documents/doc-1:batchUpdate",
    body: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } }] },
  });
  await request(f, {
    service: "sheets",
    method: "PUT",
    path: "/v4/spreadsheets/sheet-1/values/Sheet1!A1",
    query: { valueInputOption: "RAW" },
    body: { values: [["value"]] },
  });
  assert.equal(f.calls.length, 3);
});

test("uploads construct multipart in core and reject oversized or malformed data", async () => {
  const f = fixture();
  await request(f, {
    method: "POST",
    path: "/drive/v3/files",
    body: { name: "file.txt" },
    upload: { mimeType: "text/plain", dataBase64: Buffer.from("hello").toString("base64") },
  });
  assert.equal(f.calls[0]!.url.pathname, "/upload/drive/v3/files");
  assert.equal(f.calls[0]!.url.searchParams.get("uploadType"), "multipart");
  assert.match(Buffer.from(f.calls[0]!.init.body as Uint8Array).toString(), /hello/);
  for (const upload of [
    { mimeType: "text/plain\r\nAuthorization: injected", dataBase64: "aGVsbG8=" },
    { mimeType: "text/plain", dataBase64: "!" },
    { mimeType: "text/plain", dataBase64: "A".repeat(15_000_000) },
  ])
    await assert.rejects(request(f, { method: "POST", path: "/drive/v3/files", upload }));
  assert.equal(f.calls.length, 1);
});

test("trash requires exact one-use approval and rejects agent approval flags", async () => {
  const f = fixture();
  const e = await approval(f);
  assert.deepEqual(e.grantModes, { session: false, always: false });
  assert.equal(e.summary, e.command);
  assert.match(e.command, /Quarterly report/);
  assert.match(e.command, /file-1/);
  assert.match(e.command, /recoverable/);
  assert.equal(
    f.calls.some((c) => c.init.method === "PATCH"),
    false,
  );
  f.grants.add(JSON.stringify([e.command, e.approvalKey]));
  await f.service.call("google_workspace_trash", { fileId: "file-1" });
  assert.equal(f.calls.filter((c) => c.init.method === "PATCH").length, 1);
  await approval(f);
  await assert.rejects(f.service.call("google_workspace_trash", { fileId: "file-1", approved: true }));
  assert.equal(f.calls.filter((c) => c.init.method === "PATCH").length, 1);
});

for (const change of ["metadata", "account", "identity", "contents"] as const)
  test(`trash reapproves changed ${change}`, async () => {
    const f = fixture();
    f.target({ ...file(), mimeType: "application/vnd.google-apps.folder" });
    f.children([{ ...file("child-1", "Child"), parents: ["file-1"] }]);
    const e = await approval(f);
    assert.match(e.command, /Child/);
    f.grants.add(JSON.stringify([e.command, e.approvalKey]));
    if (change === "metadata") f.target({ ...file(), name: "Changed", mimeType: "application/vnd.google-apps.folder" });
    if (change === "identity") f.identity("google-user-2");
    if (change === "contents") f.children([{ ...file("child-1", "Changed child"), parents: ["file-1"] }]);
    const next = await approval(f, { fileId: "file-1", ...(change === "account" ? { accountType: "company" } : {}) });
    assert.notEqual(next.approvalKey, e.approvalKey);
    assert.equal(
      f.calls.some((c) => c.init.method === "PATCH"),
      false,
    );
  });

for (const problem of ["incomplete", "oversized", "pagination", "missing metadata"] as const)
  test(`folder preview fails closed for ${problem}`, async () => {
    const f = fixture();
    f.target({ ...file(), mimeType: "application/vnd.google-apps.folder" });
    if (problem === "incomplete") f.incomplete();
    if (problem === "oversized")
      f.children(Array.from({ length: 101 }, (_, i) => ({ ...file(`child-${i}`), parents: ["file-1"] })));
    if (problem === "pagination") f.pagination();
    if (problem === "missing metadata") f.children([{ id: "unknown" }]);
    await assert.rejects(
      f.service.call("google_workspace_trash", { fileId: "file-1" }),
      (e: unknown) => e instanceof Error && !(e instanceof NeedsApproval),
    );
    assert.equal(
      f.calls.some((c) => c.init.method === "PATCH"),
      false,
    );
  });

test("redirects and server errors fail without returning response secrets", async () => {
  const f = fixture();
  for (const status of [302, 401, 500]) {
    f.status(status);
    await assert.rejects(
      request(f, {}),
      (e: unknown) => e instanceof Error && !e.message.includes("server-only-secret"),
    );
  }
});

test("trash binds conditional mutation to the observed ETag and displays account identity", async () => {
  const f = fixture();
  const e = await approval(f);
  assert.match(e.command, /reader@example.test/);
  f.grants.add(JSON.stringify([e.command, e.approvalKey]));
  await f.service.call("google_workspace_trash", { fileId: "file-1" });
  const mutation = f.calls.find((c) => c.init.method === "PATCH")!;
  assert.equal(new Headers(mutation.init.headers).get("if-match"), '"file-version-1"');
});

test("approval previews fail closed instead of hiding affected files through truncation", async () => {
  const f = fixture();
  f.target({ ...file(), name: "x".repeat(2500) });
  await assert.rejects(
    f.service.call("google_workspace_trash", { fileId: "file-1" }),
    (e: unknown) => e instanceof Error && !(e instanceof NeedsApproval),
  );
  assert.equal(
    f.calls.some((c) => c.init.method === "PATCH"),
    false,
  );
});

test("a ten MiB valid upload stays within the supported upload limit", async () => {
  const f = fixture();
  await request(f, {
    method: "POST",
    path: "/drive/v3/files",
    upload: {
      mimeType: "application/octet-stream",
      dataBase64: Buffer.alloc(10 * 1024 * 1024, 123).toString("base64"),
    },
  });
  assert.equal(f.calls.length, 1);
});

test("folder approval includes recursively enumerated descendants and detects grandchild changes", async () => {
  const f = fixture();
  f.target({ ...file(), mimeType: "application/vnd.google-apps.folder" });
  f.children([
    { ...file("child-folder", "Nested folder"), mimeType: "application/vnd.google-apps.folder", parents: ["file-1"] },
  ]);
  f.children([{ ...file("grandchild", "Nested document"), parents: ["child-folder"] }], "child-folder");
  const first = await approval(f);
  assert.match(first.command, /Nested document/);
  assert.match(first.command, /2 descendants/);
  f.grants.add(JSON.stringify([first.command, first.approvalKey]));
  f.children([{ ...file("grandchild", "Changed nested document"), parents: ["child-folder"] }], "child-folder");
  const next = await approval(f);
  assert.notEqual(first.approvalKey, next.approvalKey);
  assert.equal(
    f.calls.some((c) => c.init.method === "PATCH"),
    false,
  );
});

test("a changed ETag requires approval and a conditional write conflict consumes its one-use grant", async () => {
  const f = fixture();
  const first = await approval(f);
  f.grants.add(JSON.stringify([first.command, first.approvalKey]));
  f.etag('"file-version-2"');
  const second = await approval(f);
  assert.notEqual(first.approvalKey, second.approvalKey);
  f.grants.add(JSON.stringify([second.command, second.approvalKey]));
  f.patchStatus(412);
  await assert.rejects(f.service.call("google_workspace_trash", { fileId: "file-1" }), /HTTP 412/);
  assert.equal(f.events.at(-1)?.status, "failed");
  await approval(f);
  assert.equal(f.calls.filter((c) => c.init.method === "PATCH").length, 1);
});

test("missing selected account never falls back to another account or operator token", async () => {
  const accounts: Array<string | undefined> = [];
  const service = createGoogleWorkspaceService({
    principalId: "person-1",
    tokens: {
      connectorAccessToken: async (_host: string, _principal: string, account?: string) => {
        accounts.push(account);
        return null;
      },
    } as ConnectorTokenStore,
    authorize: () => false,
    fetchImpl: (async () => {
      assert.fail("must not fetch without user token");
    }) as typeof fetch,
  });
  await assert.rejects(
    service.call("google_workspace_request", {
      service: "drive",
      method: "GET",
      path: "/drive/v3/files",
      accountType: "personal",
    }),
    /Connect the selected Google account/,
  );
  assert.deepEqual(accounts, ["personal"]);
});
