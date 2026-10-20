// LAB-188: a one-time grant covers the run that first claims it. A failed first
// command may be retried in the same run (or a worker retry of that run), while
// another run is refused and revocation still ends access mid-run.
import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import * as mockHarness from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { createKeychain, credentialHandle } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";

const SECRET = "lab188-synthetic-secret";
// The first command sees the secret and fails; the retry sees it and succeeds.
const FAILING = `[ "$ASHBY_TOKEN" = "${SECRET}" ] && echo saw-secret; exit 1`;
const RETRY = `[ "$ASHBY_TOKEN" = "${SECRET}" ] && echo recovered`;

let exercise: (turn: HarnessTurnInput) => Promise<string>;
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = async (turn) => ({ reply: await exercise(turn) });
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

async function setup() {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "once-grant-run-")), signingSecret: "lab188-secret".repeat(4) }),
  );
  const keychain = built.keychain!;
  const credential = await keychain.save({ ownerId: "OWNER", service: "ashby", envKey: "ASHBY_TOKEN", secret: SECRET });
  const grant = await keychain.createGrant({
    credentialId: credential.id,
    ownerId: "OWNER",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "fetch the Ashby report",
  });
  await selectDefaultSandbox(built, "ASKER", "channel:C1");
  const credentials = [credentialHandle(credential)];
  const run = async (turn: HarnessTurnInput, command: string) => {
    try {
      return (await turn.tools.execute(command, { credentials })).stdout.trim();
    } catch (e) {
      return `refused: ${(e as Error).message}`;
    }
  };
  const turn = (idempotencyKey: string) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "ASKER" },
      conversation: {
        kind: "channel",
        channelRef: "C1",
        threadRef: "ch:C1",
        audience: [{ externalId: "ASKER" }, { externalId: "OWNER" }],
      },
      text: "fetch the report",
      idempotencyKey,
    } as TurnRequest);
  return { keychain, grant, run, turn };
}

test("a one-time grant survives a failed first command for a retry in the same run, not another run", async () => {
  const { keychain, grant, run, turn } = await setup();
  exercise = async (t) => {
    assert.equal(await run(t, FAILING), "saw-secret");
    return run(t, RETRY);
  };
  assert.equal((await turn("run-1")).reply, "recovered");
  assert.equal((await keychain.getGrant(grant.id))?.status, "used");
  exercise = (t) => run(t, RETRY);
  assert.match((await turn("run-2")).reply ?? "", /^refused: .*not available/);
});

test("revoking the grant mid-run refuses the retry", async () => {
  const { keychain, grant, run, turn } = await setup();
  exercise = async (t) => {
    assert.equal(await run(t, FAILING), "saw-secret");
    assert.equal(await keychain.revokeGrant("OWNER", grant.id), true);
    return run(t, RETRY);
  };
  assert.match((await turn("run-1")).reply ?? "", /^refused: .*not available/);
  assert.equal((await keychain.getGrant(grant.id))?.status, "revoked");
});

test("a worker retry of the same run keeps the grant", async () => {
  const { keychain, grant, run, turn } = await setup();
  let attempts = 0;
  exercise = async (t) => {
    if (++attempts > 1) return run(t, RETRY);
    assert.equal(await run(t, FAILING), "saw-secret");
    throw new Error("simulated crash after the first command");
  };
  await assert.rejects(turn("run-1"), /simulated crash/);
  assert.equal((await keychain.getGrant(grant.id))?.status, "used");
  assert.equal((await turn("run-1")).reply, "recovered");
  assert.equal(attempts, 2);
  exercise = (t) => run(t, RETRY);
  assert.match((await turn("run-2")).reply ?? "", /^refused: .*not available/);
});

test("keychain: a claimed one-time grant stays usable only for its run, and only while live", async () => {
  let time = 100;
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("lab188"),
    now: () => time,
  } as Parameters<typeof createKeychain>[0]);
  const credential = await keychain.save({ ownerId: "owner", service: "ashby", envKey: "TOKEN", secret: "s" });
  const grant = await keychain.createGrant({
    credentialId: credential.id,
    ownerId: "owner",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "test",
    expiresAt: 200,
  });
  const use = async (runId?: string) =>
    (await keychain.prepareMaterialize(grant.id, "channel:C1", "actor", runId)).commit();
  await use("run-A");
  const claimed = await keychain.getGrant(grant.id);
  assert.equal(claimed?.usedInRun, "run-A");
  await use("run-A");
  assert.deepEqual(await keychain.getGrant(grant.id), claimed, "a repeat use keeps the first-use record");
  assert.equal((await keychain.grantsForScope("channel:C1", "run-A")).length, 1);
  assert.equal((await keychain.grantsForScope("channel:C1", "run-B")).length, 0);
  assert.equal((await keychain.grantsForScope("channel:C1")).length, 0);
  await assert.rejects(use("run-B"), /already used/);
  await assert.rejects(use(), /already used/);
  const pending = await keychain.prepareMaterialize(grant.id, "channel:C1", "actor", "run-A");
  time = 201;
  await assert.rejects(pending.commit(), /expired/);
  assert.equal((await keychain.grantsForScope("channel:C1", "run-A")).length, 0);
  time = 150;
  assert.equal(await keychain.revokeGrant("owner", grant.id), true);
  assert.equal((await keychain.getGrant(grant.id))?.status, "revoked", "a used grant can still be revoked");
  await assert.rejects(use("run-A"), /revoked/);
});
