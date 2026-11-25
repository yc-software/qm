import assert from "node:assert/strict";
import { test } from "node:test";
import { setupCardsIn } from "../src/setup-cards.ts";
import { item } from "./item-fixture.ts";

test("only successful card tool results become setup cards", () => {
  const result = (seq: number, callId: string, body: Record<string, unknown>, isError = false) => ({
    item: item("ToolResult", { seq, createdAt: seq, tool: "card", callId, isError, body }),
  });
  const activity = [
    result(1, "a", { display: { kind: "apps", toolkit: "notion" } }),
    result(2, "b", { error: "QM isn't in the company's Slack" }, true),
    result(3, "c", { display: { kind: "link_slack" } }),
    result(4, "d", { display: { kind: "unknown" } }),
    {
      item: item("ToolResult", {
        seq: 5,
        createdAt: 5,
        tool: "execute",
        callId: "e",
        body: { display: { kind: "apps" } },
      }),
    },
  ];
  assert.deepEqual(setupCardsIn(activity), [
    { kind: "apps", toolkit: "notion", callId: "a" },
    { kind: "link_slack", toolkit: "", callId: "c" },
  ]);
});
