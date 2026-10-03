import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyOwnerOfCronEdit } from "../src/triggers/edit-notice.ts";
import type { Cron } from "../src/types.ts";

test("cron edit notice escapes an editor-controlled title so it cannot inject Slack links", async () => {
  const sent: string[] = [];
  const cron = {
    id: "c1",
    owner: "owner@x.com",
    ownerScopeId: "channel:C1",
    runAs: "scopeShared",
    title: "daily> click <https://evil.example|here",
  } as unknown as Cron;
  for (const url of ["https://qm.example/crons/c1", undefined]) {
    await notifyOwnerOfCronEdit(
      {
        enqueueDelivery: async ({ text }) => void sent.push(text),
        directoryMember: async (id) => ({ displayName: id === "owner@x.com" ? "Owner" : "Ed <!here>" }),
        cronAdminUrl: () => url,
      },
      { cron, editorId: "editor@x.com", changeSummary: ["title"] },
    );
  }
  assert.equal(sent.length, 2);
  for (const text of sent) {
    assert.doesNotMatch(text, /<https:\/\/evil/);
    assert.doesNotMatch(text, /<!here>/);
    assert.match(text, /daily&gt; click &lt;https:\/\/evil\.example\|here/);
  }
  assert.match(sent[0]!, /^Heads up: Ed &lt;!here&gt; renamed your <https:\/\/qm\.example\/crons\/c1\|daily&gt;/);
});
