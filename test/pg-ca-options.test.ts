import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { configurePgCaTrust, pgConnectionOptions, resolvePgCaTrust } from "../src/persistence/pg-pool.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

test("configured CA trust reaches the Postgres client when the URL specifies SSL settings", (t) => {
  configurePgCaTrust({ cert: PEM });
  t.after(() => configurePgCaTrust({}));
  for (const query of [
    "sslmode=verify-full",
    "sslmode=require",
    "sslmode=disable",
    "sslmode=no-verify",
    "ssl=0",
    "ssl=true",
    "ssl=no-verify",
    "sslnegotiation=direct",
  ]) {
    const client = new pg.Client(pgConnectionOptions(`postgres://user:password@localhost/core?${query}`));
    assert.deepEqual(client.ssl, { ca: PEM });
  }
});

test("configured CA trust preserves the Postgres client certificate and key", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pgca-client-"));
  const cert = join(dir, "client.crt");
  const key = join(dir, "client.key");
  writeFileSync(cert, "client-certificate");
  writeFileSync(key, "client-key");
  const url = new URL("postgres://user:password@localhost/core?sslmode=verify-full");
  url.searchParams.set("sslcert", cert);
  url.searchParams.set("sslkey", key);
  configurePgCaTrust({ cert: PEM });
  t.after(() => configurePgCaTrust({}));
  const client = new pg.Client(pgConnectionOptions(url.toString()));
  assert.deepEqual(client.ssl, { ca: PEM, cert: "client-certificate" });
  assert.equal(Object.getOwnPropertyDescriptor(client.ssl, "key")?.value, "client-key");
});

test("Postgres URL SSL settings remain effective without a configured CA", () => {
  const client = new pg.Client(pgConnectionOptions("postgres://user:password@localhost/core?sslmode=disable"));
  assert.equal(client.ssl, false);
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
