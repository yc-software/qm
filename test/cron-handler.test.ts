import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createFireHandler, type FireReport, type HandlerDecision } from "../src/cron/handler/fire-handler.ts";
import { createHandlerInboxes, type HandlerInbox } from "../src/cron/handler/handler-inbox.ts";
import { scopeId, type Destination, type TurnResult } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";

const OWNER = "pat@example.com";
const HOME = scopeId("personal", OWNER);
const DM: Destination = { type: "principal", target: OWNER, audienceScopeId: HOME, onBehalfOf: OWNER };
const PDT_9AM = Date.parse("2026-11-10T17:00:00Z");

const report = (cronId: string, text: string, at = PDT_9AM - 3_600_000, urgent = false): FireReport => ({
  cronId,
  cronTitle: `Task ${cronId}`,
  at,
  text,
  ...(urgent ? { urgent } : {}),
});

describe("fire handler decisions", () => {
  it("applies the model's per-report choices and holds digest items in state", async () => {
    const handler = createFireHandler({
      model: async () =>
        JSON.stringify({
          decisions: [
            { report: 1, action: "drop", reason: "nothing happened" },
            { report: 2, action: "now", text: "Deploy failed on main." },
            { report: 3, action: "digest", text: "3 new signups." },
          ],
        }),
    });
    const d = await handler.handle(
      [report("a", "Routine cron noise."), report("b", "deploy failed"), report("c", "3 signups")],
      PDT_9AM,
    );
    const expected: HandlerDecision = {
      sendNow: ["Deploy failed on main."],
      digestItems: ["3 new signups."],
      dropped: [{ cronId: "a", reason: "nothing happened" }],
    };
    assert.deepEqual(d, expected);
    assert.equal(handler.state.digest.length, 1);
  });

  it("sends urgent reports now and holds the rest when the model reply is unusable", async () => {
    const handler = createFireHandler({ model: async () => "not json" });
    const d = await handler.handle([report("a", "server down", PDT_9AM, true), report("b", "weekly stats")], PDT_9AM);
    assert.deepEqual(d.sendNow, ["server down"]);
    assert.deepEqual(d.digestItems, ["weekly stats"]);
  });

  it("flushes the held digest once and then has nothing to send", async () => {
    const handler = createFireHandler({
      model: async () => "Digest: weekly stats",
      state: { digest: [{ cronId: "b", cronTitle: "Task b", at: 1, text: "weekly stats" }] },
    });
    assert.equal(await handler.flushDigest(PDT_9AM), "Digest: weekly stats");
    assert.equal(await handler.flushDigest(PDT_9AM), null);
  });
});

function triggerDeps(reply: string, handler: TriggerDeps["handler"]): TriggerDeps {
  return {
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(testMap()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run: async (): Promise<TurnResult> => ({ status: "ok", reply }),
    ...(handler ? { handler } : {}),
  };
}

describe("cron replies addressed to their owner", () => {
  it("go to the owner's handler instead of straight to their DM, with the urgent marker parsed", async () => {
    const accepted: Parameters<NonNullable<TriggerDeps["handler"]>["accept"]>[0][] = [];
    const deps = triggerDeps("[urgent]\nDisk is full.", { accept: async (x) => void accepted.push(x) });
    await runTrigger(deps, {
      owner: OWNER,
      ownerScopeId: HOME,
      cronId: "c1",
      title: "Disk watch",
      input: "check",
      fireKey: "cron:c1:1",
      surface: "cron",
      destination: DM,
    });
    assert.deepEqual(await deps.deliveries.pending("principal"), []);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.report.text, "Disk is full.");
    assert.equal(accepted[0]!.report.urgent, true);
    assert.equal(accepted[0]!.report.cronTitle, "Disk watch");
  });

  it("still post directly when the destination is a shared channel", async () => {
    const accepted: unknown[] = [];
    const deps = triggerDeps("Standup reminder", { accept: async (x) => void accepted.push(x) });
    await runTrigger(deps, {
      owner: OWNER,
      ownerScopeId: HOME,
      cronId: "c2",
      input: "remind",
      fireKey: "cron:c2:1",
      surface: "cron",
      destination: { type: "slack", target: "C0TEAM" },
    });
    assert.equal(accepted.length, 0);
    assert.equal((await deps.deliveries.pending("slack")).length, 1);
  });
});

describe("handler inbox wakes", () => {
  function inbox(modelReply: (prompt: string) => string) {
    const deliveries = createDeliveryStore();
    const prompts: string[] = [];
    const service = createHandlerInboxes({
      inboxes: testMap<HandlerInbox>(),
      deliveries,
      ask: async (_o, _s, _t, prompt) => {
        prompts.push(prompt);
        return modelReply(prompt);
      },
    });
    return { service, deliveries, prompts };
  }
  const nowDecision = JSON.stringify({
    decisions: [
      { report: 1, action: "now" },
      { report: 2, action: "now" },
    ],
  });

  it("coalesces reports into one handler turn per ten minutes unless one is urgent", async () => {
    const t0 = PDT_9AM - 3_600_000;
    const { service, deliveries, prompts } = inbox(() => nowDecision);
    await service.accept({ owner: OWNER, ownerScopeId: HOME, destination: DM, report: report("a", "one", t0) });
    await service.accept({ owner: OWNER, ownerScopeId: HOME, destination: DM, report: report("b", "two", t0) });
    await service.sweep(t0);
    assert.equal(prompts.length, 1, "both reports arrive in one turn");
    assert.equal((await deliveries.pending("principal")).length, 2);

    await service.accept({ owner: OWNER, ownerScopeId: HOME, destination: DM, report: report("c", "three", t0) });
    await service.sweep(t0 + 60_000);
    assert.equal(prompts.length, 1, "a non-urgent report waits for the next window");

    await service.accept({
      owner: OWNER,
      ownerScopeId: HOME,
      destination: DM,
      report: report("d", "fire", t0, true),
    });
    await service.sweep(t0 + 120_000);
    assert.equal(prompts.length, 2, "an urgent report wakes the handler at once");
  });

  it("flushes held items as one digest message at the owner's 9:00", async () => {
    const t0 = PDT_9AM - 3_600_000;
    const { service, deliveries } = inbox((p) =>
      p.includes('reason="digest"')
        ? "Today: stats are up."
        : JSON.stringify({ decisions: [{ report: 1, action: "digest" }] }),
    );
    await service.accept({ owner: OWNER, ownerScopeId: HOME, destination: DM, report: report("a", "stats", t0) });
    await service.sweep(t0);
    assert.equal((await deliveries.pending("principal")).length, 0);
    await service.sweep(PDT_9AM + 1000);
    const sent = await deliveries.pending("principal");
    assert.deepEqual(
      sent.map((d) => d.text),
      ["Today: stats are up."],
    );
  });
});
