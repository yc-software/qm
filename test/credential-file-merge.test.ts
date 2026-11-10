import assert from "node:assert/strict";
import test from "node:test";
import { credentialFileExpiry, mergeCredentialFiles } from "../src/credentials/file-merge.ts";
import type { CredentialFile } from "../src/credentials/keychain.ts";

const file = (path: string, content: unknown): CredentialFile => ({
  path,
  contentBase64: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)).toString("base64"),
});
const hash = (f: CredentialFile) => `${f.path}:${f.contentBase64}`;
const baselineOf = (files: CredentialFile[]) => new Map(files.map((f) => [f.path, hash(f)]));
const text = (files: CredentialFile[]) =>
  Object.fromEntries(files.map((f) => [f.path, Buffer.from(f.contentBase64, "base64").toString()]));

test("expiry is read from AWS SSO, AWS CLI and epoch-style fields", () => {
  assert.equal(credentialFileExpiry(file("a", { expiresAt: "2026-11-09T18:00:00Z" })), Date.parse("2026-11-09T18:00:00Z"));
  assert.equal(
    credentialFileExpiry(file("b", { Credentials: { Expiration: "2026-11-09T19:00:00+00:00" } })),
    Date.parse("2026-11-09T19:00:00Z"),
  );
  assert.equal(credentialFileExpiry(file("c", { expires_at: 1_800_000_000 })), 1_800_000_000_000);
  assert.equal(credentialFileExpiry(file("d", { expiry: "1800000000000" })), 1_800_000_000_000);
  assert.equal(credentialFileExpiry(file("e", "[default]\nregion = us-east-1\n")), undefined);
  assert.equal(credentialFileExpiry(file("f", { expiresAt: "soon" })), undefined);
});

test("each side keeps the files only it changed, including deletions", () => {
  const base = [file("config", "c0"), file("token", "t0"), file("wal", "w0"), file("extra", "x0")];
  const merged = mergeCredentialFiles({
    baseline: baselineOf(base),
    stored: [file("config", "c-store"), file("token", "t0"), file("wal", "w0"), file("extra", "x0")],
    refreshed: [file("config", "c0"), file("token", "t-cmd"), file("extra", "x0"), file("new", "n")],
    hash,
  });
  assert.deepEqual(text(merged), { config: "c-store", extra: "x0", new: "n", token: "t-cmd" });
});

test("a deletion never removes a file the other side changed", () => {
  const base = [file("token", "t0")];
  assert.deepEqual(
    text(mergeCredentialFiles({ baseline: baselineOf(base), stored: [file("token", "t-store")], refreshed: [], hash })),
    { token: "t-store" },
  );
  assert.deepEqual(
    text(mergeCredentialFiles({ baseline: baselineOf(base), stored: [], refreshed: [file("token", "t-cmd")], hash })),
    { token: "t-cmd" },
  );
});

test("true conflicts keep the later expiry, else the stored version", () => {
  const base = [file("token", { expiresAt: "2026-11-09T17:00:00Z" }), file("blob", "b0")];
  const merged = mergeCredentialFiles({
    baseline: baselineOf(base),
    stored: [file("token", { v: "store", expiresAt: "2026-11-09T18:00:00Z" }), file("blob", "b-store")],
    refreshed: [file("token", { v: "cmd", expiresAt: "2026-11-09T19:00:00Z" }), file("blob", "b-cmd")],
    hash,
  });
  const out = text(merged);
  assert.equal(JSON.parse(out.token!).v, "cmd");
  assert.equal(out.blob, "b-store");
});

test("an unknown baseline treats every difference as a conflict", () => {
  const merged = mergeCredentialFiles({
    baseline: null,
    stored: [file("token", { v: "store", expiresAt: "2026-11-09T20:00:00Z" }), file("blob", "b-store")],
    refreshed: [file("token", { v: "cmd", expiresAt: "2026-11-09T19:00:00Z" }), file("blob", "b-cmd")],
    hash,
  });
  const out = text(merged);
  assert.equal(JSON.parse(out.token!).v, "store");
  assert.equal(out.blob, "b-store");
});
