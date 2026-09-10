import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { emailDraftsIn, type EmailDraftActivity } from "../src/email-draft.ts";

test("email drafts come only from successful send_email results, one card per item", () => {
  const activity: EmailDraftActivity[] = [
    { type: "tool_call", payload: { tool: "send_email", to: ["a@b.co"] } },
    { type: "tool_result", payload: { tool: "send_email", display: { emailDraft: { loopId: "l1", itemId: "i1" } } } },
    { type: "tool_result", payload: { tool: "send_email", display: { emailDraft: { loopId: "l1", itemId: "i1" } } } },
    {
      type: "tool_result",
      payload: { tool: "send_email", isError: true, display: { emailDraft: { loopId: "l1", itemId: "i2" } } },
    },
    { type: "tool_result", payload: { tool: "miniapp", display: { emailDraft: { loopId: "l1", itemId: "i3" } } } },
    { type: "tool_result", payload: { tool: "send_email", display: { emailDraft: { loopId: "l1" } } } },
  ];
  assert.deepEqual(emailDraftsIn(activity), [{ loopId: "l1", itemId: "i1" }]);
  assert.deepEqual(emailDraftsIn(undefined), []);
});

test("the chat renders a card for every drafted email and the browser can reach its ledger item", () => {
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  assert.match(chat, /for \(const draft of emailDraftsIn\(\(message as AssistantWork\)\.work\?\.activity\)\)/);
  const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(
    server,
    /if \(loopsPath && !ledgerPath && !isLoopsUser\(user\)\)/,
    "ledger item routes stay open to every signed-in user; core checks loop ownership",
  );
  const widget = readFileSync(new URL("../src/email-draft-card.ts", import.meta.url), "utf8");
  assert.match(widget, /expectedProposalAt: basedOnAt/, "edits and sends carry the draft revision they were based on");
  assert.match(widget, /\/draft changed\/i/, "a 409 from an agent redraft reloads instead of clobbering");
});
