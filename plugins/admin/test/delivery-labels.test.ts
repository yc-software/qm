import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = ["deliverySurfaceLabel", "deliveryLabel"]
  .map((name) => {
    const match = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {6}\\}`));
    assert.ok(match, `${name} exists`);
    return match[0];
  })
  .join("\n");
const labels = new Function(`${source}; return { deliverySurfaceLabel, deliveryLabel };`)();

for (const [type, surface] of [
  ["web", "Web"],
  ["slack", "Slack"],
  ["principal", "Slack DM"],
  ["telegram", "telegram"],
  [undefined, "Unknown surface"],
]) {
  test(`delivery labels describe ${type ?? "missing"} destinations independently of origin`, () => {
    const event = { destination: { type }, provenance: { surface: "slack" } };
    assert.equal(labels.deliverySurfaceLabel(event), surface);
    assert.equal(labels.deliveryLabel(event), `${surface} delivery`);
    assert.equal(labels.deliveryLabel({ ...event, shadow: true }), "Shadow delivery");
    assert.equal(labels.deliverySurfaceLabel({ ...event, shadow: true }), surface);
  });
}

test("tool-associated and standalone deliveries use the same surface labels", () => {
  assert.match(html, /dlabel.textContent = deliveryLabel\(delivery\)/);
  assert.match(html, /badge\(deliverySurfaceLabel\(delivery\), "info"\)/);
  assert.match(html, /label.textContent = event.shadow \|\| isDelivery \? deliveryLabel\(event\)/);
  assert.match(html, /badge\(deliverySurfaceLabel\(event\), "info"\)/);
  assert.doesNotMatch(html, /"Slack delivery"|const slackDelivery/);
});
