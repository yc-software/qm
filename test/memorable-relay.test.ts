import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayRecord } from "../src/memorable/relay.ts";
import { loadConfig } from "../src/config.ts";
import type { MemorableCapture } from "../src/memorable/capture.ts";

const capture: MemorableCapture = {
  session_id: "s1",
  scope_id: "personal:U1",
  task_description: "Fix the failing order tests",
  tool_calls: [{ name: "execute", input: { command: "./test.sh" }, result: { ok: true, exit_code: 0 } }],
};

test("relayRecord pipes the capture as JSON to the configured binary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memorable-relay-"));
  const sink = join(dir, "sink.mjs");
  const out = join(dir, "out.json");
  writeFileSync(
    sink,
    `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(out)}, readFileSync(0, "utf8") + "|" + process.argv.slice(2).join(" "));\n`,
  );
  await relayRecord(`node ${sink}`, capture);
  const [body, args] = readFileSync(out, "utf8").split("|");
  assert.deepEqual(JSON.parse(body ?? ""), capture);
  assert.equal(args, "record --scope personal:U1");
});

test("relayRecord resolves quietly when the binary is missing", async () => {
  await relayRecord("memorable-binary-that-does-not-exist", capture);
});

test("memorableEnabled defaults off; MEMORABLE=1 enables; QM_MEMORABLE=0 kills", () => {
  assert.equal(loadConfig({}).memorableEnabled, false);
  assert.equal(loadConfig({ MEMORABLE: "1" }).memorableEnabled, true);
  assert.equal(loadConfig({ MEMORABLE: "1", QM_MEMORABLE: "0" }).memorableEnabled, false);
  assert.equal(loadConfig({}).memorableBin, "memorable");
});
