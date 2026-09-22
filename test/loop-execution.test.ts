import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { createLoopFireService } from "../src/loops/loop-fire.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { encodeRef, serviceCredRef } from "../src/acl/resource-ref.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

for (const checkResult of ["passed", "failed", "missing"] as const) {
  test(`loop intake executes with granted credentials and ${checkResult} checks gate held outputs`, async () => {
    const built = buildApp(testConfig());
    const org = scopeId("org", "default-org");
    await built.serviceCreds.setServiceCredential(org, {
      slug: "error-source",
      name: "Error source",
      delivery: "env",
      envKey: "ERROR_SOURCE_TOKEN",
      secret: "synthetic-error-source-token",
      host: "",
    });
    await built.acl.grant({
      ownerScopeId: org,
      ref: encodeRef(serviceCredRef("error-source")),
      granteeScopeId: org,
      permission: "read",
      grantedBy: "admin@default-org",
    });
    const { store: loops, items, outputs, grants } = built.loops;
    const check = checkResult === "failed" ? "test ! -s loop-proposal.txt" : "test -s loop-proposal.txt";
    const stages: string[] = [];
    const fire = createLoopFireService({
      loops,
      items,
      outputs,
      grants,
      trigger: {
        identity: built.identity,
        deliveries: built.deliveries,
        idempotency: createIdempotencyStore(),
        run: async (req) => {
          const stage = /^\[Loop (\w+)\]/.exec(req.text ?? "")?.[1];
          assert.ok(stage);
          stages.push(stage);
          assert.notEqual(req.surfaceTools, true);
          assert.notEqual(req.addressed, true);
          let command: string;
          if (stage === "intake")
            command = 'test "$ERROR_SOURCE_TOKEN" = synthetic-error-source-token && printf source-readable';
          else if (stage === "work") command = "printf 'RCA and proposed fix' > loop-proposal.txt && printf prepared";
          else if (stage === "judge") command = `${check} && printf verified`;
          else command = "printf shipped";
          const result = await built.app.turn({ ...req, text: `!run ${command}` });
          assert.equal(result.status, "ok");
          if (stage === "intake") {
            assert.equal(result.reply, "source-readable");
            return { ...result, reply: JSON.stringify([{ sourceKey: "ERROR-1", sourceSummary: "Synthetic error" }]) };
          }
          if (stage === "work") {
            assert.equal(result.reply, "prepared");
            return {
              ...result,
              reply: JSON.stringify({ outputs: [{ shipAction: "open_pr", title: "Proposed fix" }] }),
            };
          }
          if (stage === "judge") {
            assert.equal(result.reply, checkResult === "failed" ? "(exit 1)" : "verified");
            return {
              ...result,
              reply: JSON.stringify({
                outcome: "met",
                reason: "RCA and fix prepared",
                checks: checkResult === "missing" ? [] : [{ command: check, passed: result.reply === "verified" }],
              }),
            };
          }
          return result;
        },
      },
    });
    const { loop } = await loops.create({
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      name: "Error RCA",
      playbook: "Read errors and prepare an RCA and proposed fix.",
      successCondition: "RCA and proposed fix are prepared and the check passes.",
      successChecks: [check],
      shipActions: [{ action: "open_pr", gate: "hold" }],
      caps: { maxItemAttempts: 1 },
    });
    const result = await fire.fire(loop.id, "execution-test");
    assert.deepEqual(stages, ["intake", "work", "judge"]);
    const held = await outputs.awaitingReview(loop.id);
    if (checkResult === "passed") {
      assert.equal(result.summary?.ready.length, 1);
      assert.equal(held.length, 1);
      assert.equal(held[0]?.state, "ready");
      assert.equal(result.summary?.shipped.length, 0);
      const shipped = await fire.shipOutput(loop.id, held[0]!.id, "U1");
      assert.equal(shipped?.state, "shipped");
      assert.deepEqual(stages, ["intake", "work", "judge", "ship"]);
    } else {
      assert.equal(held.length, 0);
      assert.equal(result.summary?.parked.length, 1);
      assert.equal(result.summary?.shipped.length, 0);
    }
  });
}
