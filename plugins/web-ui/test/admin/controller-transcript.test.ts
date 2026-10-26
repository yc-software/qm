import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin } from "./fixture.ts";

async function transcript(data: Record<string, unknown>) {
  const admin = await mountAdmin("/settings/history/s/sess-1", {
    "/scopes": { scopes: [], environments: [] },
    "/sessions/sess-1/llm": { requests: [] },
    "/sessions/sess-1": data,
  });
  await admin.settle(10);
  return admin;
}

const surfaces: [string | undefined, string][] = [
  ["web", "Web"],
  ["slack", "Slack"],
  ["principal", "Slack DM"],
  ["telegram", "telegram"],
  [undefined, "Unknown surface"],
];

test("delivery events are labelled by destination, not by where the turn came from", async () => {
  const admin = await transcript({
    session: { scopeId: "org:acme" },
    entries: [],
    deliveryEvents: [
      ...surfaces.map(([type], i) => ({
        type: "outbound_delivery",
        deliveryId: `d${i}`,
        createdAt: i + 1,
        destination: { type },
        provenance: { surface: "slack" },
      })),
      { type: "outbound_delivery", deliveryId: "shadow", createdAt: 10, shadow: true, destination: { type: "web" } },
    ],
  });
  const rows = [...admin.document.querySelectorAll(".delivery-event-entry")].map((row) => ({
    label: row.querySelector(".entry-label.important")!.textContent!.trim(),
    badge: row.querySelector(".badge")?.textContent?.trim(),
  }));
  assert.deepEqual(rows, [
    ...surfaces.map(([, surface]) => ({ label: `${surface} delivery`, badge: surface })),
    { label: "Shadow delivery", badge: "Web" },
  ]);
  admin.close();
});

test("a delivery folded into its tool call carries the same surface label", async () => {
  const admin = await transcript({
    session: { scopeId: "org:acme" },
    entries: [
      { seq: 1, type: "tool_call", payload: { callId: "a", name: "post" }, createdAt: 1 },
      { seq: 2, type: "tool_result", payload: { callId: "a", deliveryId: "d" }, createdAt: 2 },
    ],
    deliveryEvents: [{ type: "outbound_delivery", deliveryId: "d", createdAt: 2, destination: { type: "principal" } }],
  });
  const view = admin.document.getElementById("view-data")!.textContent!;
  assert.match(view, /Slack DM delivery/);
  assert.equal(admin.document.querySelectorAll(".delivery-event-entry").length, 0);
  admin.close();
});

test("transcript filters hide thinking and tool results but keep tool calls that carried a delivery", async () => {
  const admin = await transcript({
    session: { scopeId: "org:acme" },
    entries: [
      { seq: 1, type: "user", payload: "hello", createdAt: 1 },
      { seq: 2, type: "thinking", payload: "private thought", createdAt: 2 },
      { seq: 3, type: "tool_call", payload: { callId: "plain", name: "read" }, createdAt: 3 },
      { seq: 4, type: "tool_result", payload: { callId: "plain" }, createdAt: 4 },
      { seq: 5, type: "tool_call", payload: { callId: "sent", name: "post" }, createdAt: 5 },
      { seq: 6, type: "tool_result", payload: { callId: "sent", deliveryId: "d" }, createdAt: 6 },
      { seq: 7, type: "assistant", payload: "reply", createdAt: 7 },
    ],
    deliveryEvents: [{ type: "outbound_delivery", deliveryId: "d", createdAt: 6, destination: { type: "web" } }],
  });
  const doc = admin.document;
  const hidden = (selector: string) =>
    [...doc.querySelectorAll(`#view-data ${selector}`)].map((entry) => entry.classList.contains("filtered"));
  const plainTool = ".tool-entry:not(:has(.tool-delivery))";
  const deliveredTool = ".tool-entry:has(.tool-delivery)";
  assert.deepEqual(hidden(".thinking-entry"), [false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
  assert.deepEqual(hidden(".thinking-entry"), [true]);
  assert.deepEqual(hidden(plainTool), [false, false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show tool results"]')!.click();
  assert.deepEqual(hidden(plainTool), [true, true]);
  assert.deepEqual(hidden(deliveredTool), [false]);
  assert.deepEqual(hidden(".user-entry, .assistant-entry"), [false, false]);
  doc.querySelector<HTMLInputElement>('[aria-label="Show thinking"]')!.click();
  assert.deepEqual(hidden(".thinking-entry"), [false]);
  admin.close();
});
