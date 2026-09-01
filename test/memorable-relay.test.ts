import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayRecord } from "../src/memory/memorable/relay.ts";
import type { MemorableCapture, MemorableWorkflow } from "../src/memory/memorable/capture.ts";

const capture: MemorableCapture = {
  session_id: "s1",
  scope_id: "personal:U1",
  workflows: [
    {
      workflow_id: "s1-1",
      prompt: "Fix the failing order tests",
      tool_calls: [
        { name: "execute", input: { command: "./test.sh" }, result: { ok: false, exit_code: 1 } },
        { name: "write", input: { path: "src/orders/validate.js" } },
      ],
    },
  ],
};

function stub(script: string): { bin: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), "memorable-relay-"));
  const file = join(dir, "stub.mjs");
  const marker = join(dir, "marker");
  writeFileSync(file, script.replace("MARKER", JSON.stringify(marker)));
  return { bin: `node ${file}`, marker };
}

test("relayRecord pipes the capture as JSON to the configured binary", async () => {
  const { bin, marker } = stub(
    `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(MARKER, readFileSync(0, "utf8") + "|" + process.argv.slice(2).join(" "));\n`,
  );
  await relayRecord(bin, capture);
  const [body, args] = readFileSync(marker, "utf8").split("|");
  assert.deepEqual(JSON.parse(body ?? ""), capture);
  assert.equal(args, "record --scope personal:U1 -");
});

test("relayRecord resolves quietly when the binary is missing", async () => {
  await relayRecord("memorable-binary-that-does-not-exist", capture);
});

test("relayRecord stops waiting on a child that never exits", async () => {
  const { bin } = stub(`setInterval(() => {}, 1000);\n`);
  const outcome = await Promise.race([
    relayRecord(bin, capture, 250).then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 5_000).unref()),
  ]);
  assert.equal(outcome, "settled");
});

test("relayRecord runs the binary at all only when there is a workflow to offer", async () => {
  const { bin, marker } = stub(`import { writeFileSync } from "node:fs";\nwriteFileSync(MARKER, "ran");\n`);
  await relayRecord(bin, { session_id: "s1", scope_id: "personal:U1", workflows: [] });
  assert.equal(existsSync(marker), false);
  await relayRecord(bin, capture);
  assert.equal(readFileSync(marker, "utf8"), "ran");
});

test("the relay declines to spend an extraction call on a workflow certain to be refused", async () => {
  const { bin, marker } = stub(
    `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(MARKER, readFileSync(0, "utf8"));\n`,
  );
  const one: MemorableWorkflow = {
    workflow_id: "s1-1",
    prompt: "just look",
    tool_calls: [{ name: "execute", input: { command: "ls" } }],
  };
  const repeated: MemorableWorkflow = {
    workflow_id: "s1-2",
    prompt: "run it twice",
    tool_calls: [
      { name: "execute", input: { command: "sh test.sh" } },
      { name: "execute", input: { command: "sh test.sh" } },
    ],
  };
  await relayRecord(bin, { session_id: "s1", scope_id: "personal:U1", workflows: [one, repeated] });
  assert.equal(existsSync(marker), false);

  await relayRecord(bin, {
    session_id: "s1",
    scope_id: "personal:U1",
    workflows: [one, repeated, ...capture.workflows],
  });
  const offered = JSON.parse(readFileSync(marker, "utf8")) as MemorableCapture;
  assert.deepEqual(
    offered.workflows.map((w) => w.workflow_id),
    ["s1-1"],
  );
});

test("a session of certain refusals does not grow the offer as it grows", async () => {
  const { bin, marker } = stub(
    `import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(MARKER, readFileSync(0, "utf8"));\n`,
  );
  const workflows: MemorableWorkflow[] = [];
  for (let prompt = 1; prompt <= 8; prompt++) {
    workflows.push({
      workflow_id: `s1-${prompt}`,
      prompt: `prompt ${prompt}`,
      tool_calls: [{ name: "execute", input: { command: "ls" } }],
    });
    await relayRecord(bin, { session_id: "s1", scope_id: "personal:U1", workflows });
    assert.equal(existsSync(marker), false, `the relay spent a call on turn ${prompt}`);
  }
});

const readsKey = `import { writeFileSync } from "node:fs";\nwriteFileSync(MARKER, process.env.MEMORABLE_API_KEY ?? "<unset>");\n`;

test("relayRecord hands the child the scope's own key", async () => {
  const { bin, marker } = stub(readsKey);
  await relayRecord(bin, capture, undefined, {
    env: { PATH: process.env.PATH, MEMORABLE_API_KEY: "mk_deployment" },
    apiKey: "mk_scope",
  });
  assert.equal(readFileSync(marker, "utf8"), "mk_scope");
});

test("relayRecord falls back to the deployment key when the scope has none", async () => {
  const { bin, marker } = stub(readsKey);
  await relayRecord(bin, capture, undefined, {
    env: { PATH: process.env.PATH, MEMORABLE_API_KEY: "mk_deployment" },
  });
  assert.equal(readFileSync(marker, "utf8"), "mk_deployment");
});

test("relayRecord passes the environment it was given and nothing else", async () => {
  const { bin, marker } = stub(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(MARKER, process.env.QM_SECRET ?? "<unset>");\n`,
  );
  const before = process.env.QM_SECRET;
  process.env.QM_SECRET = "leaked";
  try {
    await relayRecord(bin, capture, undefined, { env: { PATH: process.env.PATH } });
  } finally {
    if (before === undefined) delete process.env.QM_SECRET;
    else process.env.QM_SECRET = before;
  }
  assert.equal(readFileSync(marker, "utf8"), "<unset>");
});

test("relayRecord reports a consent refusal instead of swallowing it", async () => {
  const { bin } = stub(
    `import { readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nprocess.stdout.write(JSON.stringify({ ok: false, error: "memorable_write_denied", mode: "unset", scope: "personal:U1" }) + "\\n");\nprocess.exit(3);\n`,
  );
  const outcome = await relayRecord(bin, capture, undefined, { env: { PATH: process.env.PATH } });
  assert.deepEqual(outcome, { ok: false, reason: "memorable_write_denied (consent unset)" });
});

test("relayRecord reports a plain non-zero exit when there is no refusal to read", async () => {
  const { bin } = stub(`import { readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nprocess.exit(9);\n`);
  assert.deepEqual(await relayRecord(bin, capture, undefined, { env: { PATH: process.env.PATH } }), {
    ok: false,
    reason: "exit 9",
  });
});

test("relayRecord reports success on a clean exit, and on nothing to offer", async () => {
  const { bin } = stub(`import { readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\n`);
  assert.deepEqual(await relayRecord(bin, capture, undefined, { env: { PATH: process.env.PATH } }), { ok: true });
  assert.deepEqual(await relayRecord(bin, { ...capture, workflows: [] }), { ok: true });
});
