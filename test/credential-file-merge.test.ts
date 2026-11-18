import assert from "node:assert/strict";
import test from "node:test";
import { credentialFileExpiry, mergeCredentialFiles } from "../src/credentials/file-merge.ts";
import type { CredentialFile } from "../src/credentials/keychain.ts";

const file = (path: string, content: unknown): CredentialFile => ({
  path,
  contentBase64: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)).toString("base64"),
});
const hash = (f: CredentialFile) => `${f.path}:${f.contentBase64}`;
const merge = (base: CredentialFile[], stored: CredentialFile[], refreshed: CredentialFile[]) => {
  const result = mergeCredentialFiles({
    baseline: new Map(base.map((f) => [f.path, hash(f)])),
    stored,
    refreshed,
    hash,
    refreshOnly: false,
  });
  return {
    files: Object.fromEntries(result.files.map((f) => [f.path, Buffer.from(f.contentBase64, "base64").toString()])),
    overruled: result.overruled,
    byExpiry: result.byExpiry,
  };
};
const TOKEN = ".aws/sso/cache/token.json";

test("expiry is read only from the declared AWS SSO and CLI cache files, warning only on an unparseable value or JSON file", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const at = Date.parse("2026-11-09T18:00:00Z");
  assert.equal(credentialFileExpiry(file(TOKEN, { expiresAt: "2026-11-09T18:00:00Z" })), at);
  assert.equal(
    credentialFileExpiry(
      file(".aws/cli/cache/role.json", { Credentials: { Expiration: "2026-11-09T18:00:00+00:00" } }),
    ),
    at,
  );
  assert.equal(credentialFileExpiry(file(".config/tool/token.json", { expiresAt: "2026-11-09T18:00:00Z" })), undefined);
  assert.equal(credentialFileExpiry(file(TOKEN, { accessToken: "no expiry field" })), undefined);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(credentialFileExpiry(file(".aws/cli/cache/session.db-wal", "not json")), undefined);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(credentialFileExpiry(file(TOKEN, { expiresAt: "soon" })), undefined);
  assert.equal(credentialFileExpiry(file(TOKEN, "not json")), undefined);
  assert.equal(warn.mock.callCount(), 2);
});

test("each side keeps the files only it changed, including deletions", () => {
  const base = [file("config", "c0"), file("token", "t0"), file("wal", "w0"), file("extra", "x0")];
  assert.deepEqual(
    merge(
      base,
      [file("config", "c-store"), file("token", "t0"), file("wal", "w0"), file("extra", "x0")],
      [file("config", "c0"), file("token", "t-cmd"), file("extra", "x0"), file("new", "n")],
    ),
    { files: { config: "c-store", extra: "x0", new: "n", token: "t-cmd" }, overruled: [], byExpiry: [] },
  );
});

test("a deletion never removes a file the other side changed, and is reported", () => {
  const base = [file("token", "t0")];
  assert.deepEqual(merge(base, [file("token", "t-store")], []), {
    files: { token: "t-store" },
    overruled: ["token"],
    byExpiry: [],
  });
  assert.deepEqual(merge(base, [], [file("token", "t-cmd")]), {
    files: { token: "t-cmd" },
    overruled: [],
    byExpiry: [],
  });
});

test("true conflicts keep the later declared expiry without a report, else the stored version with one", () => {
  const base = [file(TOKEN, { expiresAt: "2026-11-09T17:00:00Z" }), file("blob", "b0")];
  const later = file(TOKEN, { v: "later", expiresAt: "2026-11-09T19:00:00Z" });
  const earlier = file(TOKEN, { v: "earlier", expiresAt: "2026-11-09T18:00:00Z" });
  for (const [stored, ours] of [
    [earlier, later],
    [later, earlier],
  ] as const) {
    const { files, overruled, byExpiry } = merge(
      base,
      [stored, file("blob", "b-store")],
      [ours, file("blob", "b-cmd")],
    );
    assert.equal(JSON.parse(files[TOKEN]!).v, "later");
    assert.equal(files.blob, "b-store");
    assert.deepEqual(overruled, ["blob"]);
    assert.deepEqual(byExpiry, [{ path: TOKEN, kept: stored === later ? "stored" : "refreshed" }]);
  }
});
