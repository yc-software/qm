import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConsentMode, setConsent } from "../src/memorable/consent.ts";

function stub(script: string): { bin: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "memorable-consent-"));
  const file = join(dir, "stub.mjs");
  const marker = join(dir, "marker");
  writeFileSync(file, script.replace("MARKER", JSON.stringify(marker)));
  return { bin: `node ${file}`, marker };
}

const records = `import { writeFileSync } from "node:fs";\nwriteFileSync(MARKER, process.argv.slice(2).join(" ") + "|" + (process.env.MEMORABLE_API_KEY ?? "<unset>"));\n`;

test("parseConsentMode accepts the three modes and nothing else", () => {
  assert.equal(parseConsentMode("read-write"), "read-write");
  assert.equal(parseConsentMode("read-only"), "read-only");
  assert.equal(parseConsentMode("deny"), "deny");
  for (const bad of ["enable", "", "READ-WRITE", null, 1, {}, undefined]) {
    assert.equal(parseConsentMode(bad), null);
  }
});

test("read-write runs enable for the scope, with the scope's own key", async () => {
  const { bin, marker } = stub(records);
  const result = await setConsent(bin, "personal:U1", "read-write", {
    env: { PATH: process.env.PATH, MEMORABLE_API_KEY: "mk_deployment" },
    apiKey: "mk_scope",
  });
  assert.deepEqual(result, { ok: true, mode: "read-write" });
  assert.equal(readFileSync(marker, "utf8"), "enable --scope personal:U1|mk_scope");
});

test("read-only runs disable and deny runs forget", async () => {
  const off = stub(records);
  await setConsent(off.bin, "channel:C1", "read-only", { env: { PATH: process.env.PATH } });
  assert.equal(readFileSync(off.marker, "utf8").split("|")[0], "disable --scope channel:C1");

  const gone = stub(records);
  await setConsent(gone.bin, "channel:C1", "deny", { env: { PATH: process.env.PATH } });
  assert.equal(readFileSync(gone.marker, "utf8").split("|")[0], "forget --scope channel:C1");
});

test("a non-zero exit is reported, not swallowed", async () => {
  const { bin } = stub(`process.exit(3);\n`);
  assert.deepEqual(await setConsent(bin, "personal:U1", "read-write", { env: { PATH: process.env.PATH } }), {
    ok: false,
    reason: "exit 3",
  });
});

test("a missing binary is reported, not swallowed", async () => {
  const result = await setConsent("memorable-binary-that-does-not-exist", "personal:U1", "read-write");
  assert.equal(result.ok, false);
});

test("the scope's key is left alone when it has none", async () => {
  const { bin, marker } = stub(records);
  await setConsent(bin, "personal:U1", "read-write", {
    env: { PATH: process.env.PATH, MEMORABLE_API_KEY: "mk_deployment" },
  });
  assert.equal(readFileSync(marker, "utf8").split("|")[1], "mk_deployment");
});
