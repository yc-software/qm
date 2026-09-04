import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePgCaTrust } from "../src/persistence/pg-pool.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

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
