import { test } from "node:test";
import assert from "node:assert/strict";
import { renderComputerBlock, renderResidentLoginsBlock } from "../src/core/environment-facts.ts";
import { renderGatewayContext } from "../src/core/gateway-context.ts";
import { sharedManifest } from "../src/core/attachments.ts";
import { renderSharingPosturePrompt } from "../src/resolution/sharing-posture.ts";
import {
  deliveryMenu,
  renderConversationRoster,
  renderReachRoster,
  renderStandingObligations,
} from "../src/core/orchestrator/prompt-blocks.ts";
import { RESIDENT_AUTH_CONNECTORS } from "../src/credentials/resident-auth.ts";
import type { Cron, Webhook, Monitor, GrantedHandle, CandidateDestination } from "../src/types.ts";
import type { DirectoryMember, DirectoryChannel } from "../src/directory/directory-store.ts";

function checkOrder<T>(items: T[], render: (items: T[]) => string | null): void {
  const before = structuredClone(items);
  const expected = render(items);
  assert.equal(render(items.toReversed()), expected);
  assert.equal(render([...items.slice(3), ...items.slice(0, 3)]), expected);
  assert.deepEqual(items, before);
}

test("prompt inventories keep identical bytes across permutations, including capped subsets", () => {
  const ids = Array.from({ length: 105 }, (_, i) => `id-${String(i).padStart(3, "0")}`);
  checkOrder<DirectoryMember>(
    ids.map((id) => ({ principalId: id, displayName: "Same name", type: "internal" })),
    renderConversationRoster,
  );
  checkOrder<DirectoryChannel>(
    ids.map((id) => ({ channelId: id, name: id })),
    (items) => renderReachRoster(items, "Alex"),
  );
  checkOrder<CandidateDestination>(
    ids.map((id) => ({ key: id, label: id, type: "slack", target: id })),
    (items) => deliveryMenu(items, ids[5]),
  );
  checkOrder<GrantedHandle>(
    ids.map((id) => ({
      handlePath: `shared/${id}`,
      ownerScopeId: "personal:U1",
      ownerPath: `${id}.txt`,
      permission: "read",
    })),
    sharedManifest,
  );
  const base = ids.map((id) => ({
    id,
    ownerScopeId: "personal:U1" as const,
    owner: "U1",
    createdBy: "U1",
    createdAt: 1,
    enabled: true,
  }));
  checkOrder<Cron>(
    base.map((b) => ({ ...b, schedule: { everyMs: 60_000 }, action: b.id })),
    (items) => renderStandingObligations(items, [], []),
  );
  checkOrder<Webhook>(
    base.map((b) => ({ ...b, action: b.id, verification: { scheme: "github" } })),
    (items) => renderStandingObligations([], items, []),
  );
  checkOrder<Monitor>(
    base.map((b) => ({ ...b, processId: b.id, command: b.id, threadRef: "t", cursor: 0, expiresAt: 100 })),
    (items) => renderStandingObligations([], [], items),
  );
  assert.match(deliveryMenu([{ key: "x", label: "X", type: "slack", target: "x" }], "x"), /X \(default/);
});

test("environment and location facts are independent of discovery order", () => {
  checkOrder(["python", "node", "ruby", "bash"], (items) =>
    renderComputerBlock(
      { os: "Linux", runtimes: items, tools: items, notInstalled: items },
      { hasGlobal: false, teamCount: 0 },
    ),
  );
  checkOrder([...RESIDENT_AUTH_CONNECTORS], (items) =>
    renderResidentLoginsBlock(
      {
        scopeId: "personal:U1",
        checkedAt: 1,
        connectors: Object.fromEntries(items.map((c) => [c.id, "active" as const])),
      },
      items,
    ),
  );
  checkOrder(["channel:C2" as const, "team:T1" as const, "personal:U1" as const, "channel:C1" as const], (items) =>
    renderSharingPosturePrompt({ id: "U1", type: "internal" }, items),
  );
  checkOrder(
    [
      ["thread", "t"],
      ["channel", "c"],
      ["team", "t"],
    ],
    (items) => renderGatewayContext("slack", { details: Object.fromEntries(items) }),
  );
});
