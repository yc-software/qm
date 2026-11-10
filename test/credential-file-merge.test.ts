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
  });
  return {
    files: Object.fromEntries(result.files.map((f) => [f.path, Buffer.from(f.contentBase64, "base64").toString()])),
    overruled: result.overruled,
  };
};

test("expiry is read from the AWS SSO token cache and the AWS CLI credential cache", () => {
  assert.equal(
    credentialFileExpiry(file("a", { expiresAt: "2026-11-09T18:00:00Z" })),
    Date.parse("2026-11-09T18:00:00Z"),
  );
  assert.equal(
    credentialFileExpiry(file("b", { Credentials: { Expiration: "2026-11-09T19:00:00+00:00" } })),
    Date.parse("2026-11-09T19:00:00Z"),
  );
  assert.equal(credentialFileExpiry(file("c", { expiresAt: 1_800_000_000 })), 1_800_000_000_000);
  assert.equal(credentialFileExpiry(file("d", "[default]\nregion = us-east-1\n")), undefined);
  assert.equal(credentialFileExpiry(file("e", { expiresAt: "soon" })), undefined);
});

test("each side keeps the files only it changed, including deletions", () => {
  const base = [file("config", "c0"), file("token", "t0"), file("wal", "w0"), file("extra", "x0")];
  assert.deepEqual(
    merge(
      base,
      [file("config", "c-store"), file("token", "t0"), file("wal", "w0"), file("extra", "x0")],
      [file("config", "c0"), file("token", "t-cmd"), file("extra", "x0"), file("new", "n")],
    ),
    { files: { config: "c-store", extra: "x0", new: "n", token: "t-cmd" }, overruled: [] },
  );
});

test("a deletion never removes a file the other side changed, and is reported as overruled", () => {
  const base = [file("token", "t0")];
  assert.deepEqual(merge(base, [file("token", "t-store")], []), { files: { token: "t-store" }, overruled: ["token"] });
  assert.deepEqual(merge(base, [], [file("token", "t-cmd")]), { files: { token: "t-cmd" }, overruled: [] });
});

test("true conflicts keep the later expiry, else the stored version, and report what the command lost", () => {
  const base = [file("token", { expiresAt: "2026-11-09T17:00:00Z" }), file("blob", "b0")];
  const { files, overruled } = merge(
    base,
    [file("token", { v: "store", expiresAt: "2026-11-09T18:00:00Z" }), file("blob", "b-store")],
    [file("token", { v: "cmd", expiresAt: "2026-11-09T19:00:00Z" }), file("blob", "b-cmd")],
  );
  assert.equal(JSON.parse(files.token!).v, "cmd");
  assert.equal(files.blob, "b-store");
  assert.deepEqual(overruled, ["blob"]);
});
