import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import {
  mergeServicePrincipals,
  parseServicePrincipals,
  withServicePrincipals,
} from "../src/directory/service-principals.ts";

const service = { principalId: "agent@example.com", displayName: "Agent", type: "internal" as const, slackId: "U1" };

test("service aliases replace their surface-owned identity instead of creating ambiguous members", () => {
  assert.deepEqual(
    mergeServicePrincipals(
      [{ principalId: "U1", displayName: "Slack Agent", type: "internal", slackId: "U1" }],
      [service],
    ),
    [service],
  );
});

test("configured identities reject alias collisions across service principals", () => {
  assert.throws(
    () =>
      parseServicePrincipals(
        JSON.stringify([
          { principalId: "first@example.com", displayName: "First", slackId: "U1" },
          { principalId: "U1", displayName: "Second" },
        ]),
      ),
    /identity collision/,
  );
});

test("service principals are a config-owned overlay that disappears when configuration is removed", async () => {
  const persisted = createDirectoryStore();
  await persisted.replace([{ principalId: "U2", displayName: "Human", type: "internal", slackId: "U2" }]);

  const configured = withServicePrincipals(persisted, [service]);
  await configured.replace([
    { principalId: "U1", displayName: "Slack Agent", type: "internal", slackId: "U1" },
    { principalId: "U2", displayName: "Human", type: "internal", slackId: "U2" },
  ]);
  assert.deepEqual(await configured.get("U1"), service);
  assert.deepEqual(await configured.resolve("Agent"), { kind: "one", member: service });
  assert.deepEqual(await persisted.list(), [
    { principalId: "U2", displayName: "Human", type: "internal", slackId: "U2" },
  ]);

  const restarted = withServicePrincipals(persisted, []);
  assert.equal(await restarted.get("agent@example.com"), null);
  assert.deepEqual(await restarted.list(), [
    { principalId: "U2", displayName: "Human", type: "internal", slackId: "U2" },
  ]);
});
