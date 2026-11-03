import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePgCaTrust, pgConnectionOptions, resolvePgCaTrust } from "../src/persistence/pg-pool.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

test("configured CA trust verifies the Postgres server whatever SSL settings the URL carries", (t) => {
  configurePgCaTrust({ cert: PEM });
  t.after(() => configurePgCaTrust({}));
  for (const query of ["sslmode=verify-full", "sslmode=require", "sslmode=disable", "sslmode=no-verify", "ssl=true"]) {
    const { url, ssl } = pgConnectionOptions(`postgres://user:password@localhost/core?${query}`);
    assert.deepEqual(ssl, { ca: PEM });
    assert.equal(new URL(url).search, "");
  }
});

test("without a configured CA the URL keeps its sslmode, with no-verify mapped to unverified TLS", () => {
  const options = (query: string) => pgConnectionOptions(`postgres://user:password@localhost/core?${query}`);
  assert.deepEqual(options("sslmode=disable"), { url: "postgres://user:password@localhost/core?sslmode=disable" });
  assert.deepEqual(options("sslmode=verify-full"), {
    url: "postgres://user:password@localhost/core?sslmode=verify-full",
  });
  assert.deepEqual(options("sslmode=no-verify"), { url: "postgres://user:password@localhost/core?sslmode=require" });
});

test("no CA configured → no ssl override (connection string semantics untouched)", () => {
  assert.deepEqual(resolvePgCaTrust({}), {});
  assert.deepEqual(resolvePgCaTrust({ cert: "  " }), {});
});

test("PEM content wires into ssl.ca", () => {
  assert.deepEqual(resolvePgCaTrust({ cert: PEM }), { ssl: { ca: PEM } });
});

test("a cert file is read; inline PEM wins when both are set", () => {
  const dir = mkdtempSync(join(tmpdir(), "pgca-"));
  const file = join(dir, "root.crt");
  writeFileSync(file, PEM);
  assert.deepEqual(resolvePgCaTrust({ certFile: file }), { ssl: { ca: PEM } });
  assert.deepEqual(resolvePgCaTrust({ cert: PEM, certFile: "/nope" }), { ssl: { ca: PEM } });
});

test("an unreadable cert file fails loudly, not as silent no-verify", () => {
  assert.throws(() => resolvePgCaTrust({ certFile: "/does/not/exist.crt" }), /unreadable/);
});
