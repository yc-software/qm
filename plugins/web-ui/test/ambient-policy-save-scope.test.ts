import assert from "node:assert/strict";
import test, { after } from "node:test";
import { browserEnv } from "./browser-env.ts";

const policy = (orders: string, updatedAt: number) => ({
  policy: { orders, bots: {}, ambientEnabled: null, updatedAt },
});
let releaseSave: (r: Response) => void = () => {};

const { vite, close } = await browserEnv({
  fetch: (input, init) => {
    const path = String(input);
    if (path.endsWith(encodeURIComponent("channel:A") + "/ambient-policy")) {
      if (init?.method === "PUT") return new Promise<Response>((resolve) => (releaseSave = resolve));
      return Promise.resolve(Response.json(policy("A orders", 1)));
    }
    if (path.endsWith(encodeURIComponent("channel:B") + "/ambient-policy"))
      return Promise.resolve(Response.json(policy("B orders", 2)));
    return Promise.resolve(Response.json({}));
  },
});
after(close);

test("a save that finishes after switching scopes leaves the new scope's policy and notice untouched", async () => {
  const { render } = await vite.ssrLoadModule("lit");
  const { loadAmbientPolicy, ambientPolicySection } = await vite.ssrLoadModule("/src/ambient-policy.ts");
  const host = document.createElement("div");
  document.body.append(host);
  let scope = "channel:A";
  const draw = () => render(ambientPolicySection(scope), host);
  await loadAmbientPolicy(scope, draw);
  const orders = host.querySelector<HTMLTextAreaElement>("#ambient-orders")!;
  orders.value = "A edited";
  orders.dispatchEvent(new window.Event("input"));
  host.querySelector<HTMLButtonElement>(".ambient-policy-actions .btn.primary")!.click();
  await new Promise((r) => setTimeout(r, 0));
  scope = "channel:B";
  await loadAmbientPolicy(scope, draw);
  releaseSave(Response.json(policy("A edited", 3)));
  await new Promise((r) => setTimeout(r, 10));
  draw();
  assert.equal(host.querySelector<HTMLTextAreaElement>("#ambient-orders")!.value, "B orders");
  assert.equal(host.querySelector(".ambient-policy-status"), null);
  assert.equal(
    host.querySelector<HTMLButtonElement>(".ambient-policy-actions .btn.primary")!.textContent!.trim(),
    "Save",
  );
});
