import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { createDeploymentCredentials as Create } from "../src/deploy-credentials.ts";

const dom = new JSDOM("<!doctype html><main></main>", { url: "https://example.com/apps" });
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 0),
}))
  Object.defineProperty(globalThis, key, { configurable: true, value });
const { render, html } = await import("lit");
const vite = await createServer({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { createDeploymentCredentials } = (await vite.ssrLoadModule("/src/deploy-credentials.ts")) as {
  createDeploymentCredentials: typeof Create;
};
test.after(async () => {
  await vite.close();
  dom.window.close();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const root = dom.window.document.querySelector("main")!;
const key = {
  id: "key-a",
  ownerId: "owner@example.com",
  service: "Sample API",
  accountLabel: "Sample account",
  kind: "env",
  host: "api.example.com",
  fields: ["API_TOKEN"],
};
const binding = {
  credentialId: key.id,
  ownerId: key.ownerId,
  host: key.host,
  allowedMethods: ["GET"],
  allowedPathPrefixes: ["/v1/data"],
  headers: [{ name: "Authorization", field: "API_TOKEN", scheme: "Bearer" }],
};
function button(text: string, container: ParentNode = root): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  assert.ok(result, `button ${text}`);
  return result;
}
function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string, event = "input") {
  element.value = value;
  element.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
}
function confirm() {
  const checkbox = root.querySelector<HTMLInputElement>(".deploy-credential-confirm input")!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}
function fixture(bound = false) {
  root.replaceChildren();
  const container = document.createElement("div");
  root.append(container);
  let current = true;
  let failure: Error | null = null;
  let pending: (() => Promise<unknown>) | null = null;
  let version = 1;
  const data = {
    revision: "r1",
    credentialBindings: bound ? [binding, { ...binding, credentialId: "deleted-key" }] : [],
    credentials: [
      key,
      { ...key, id: "paired", service: "Paired", fields: ["TOKEN_ID", "TOKEN_SECRET"] },
      { ...key, id: "expired", service: "Expired", disabledReason: "This credential has expired." },
      { ...key, id: "file", service: "File login", kind: "file", disabledReason: "File logins are not supported." },
      {
        ...key,
        id: "oauth",
        service: "OAuth",
        disabledReason: "Managed OAuth credentials are not supported for apps.",
      },
    ],
  };
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const panel = createDeploymentCredentials({
    id: "app-a",
    title: "Sample app",
    isCurrent: () => current,
    request: async <T>(path: string, init?: RequestInit): Promise<T> => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      requests.push({ path, body });
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      if (pending) {
        const run = pending;
        pending = null;
        return (await run()) as T;
      }
      if (body) {
        if (body.action === "connect") data.credentialBindings.push(body.binding as typeof binding);
        else data.credentialBindings = data.credentialBindings.filter((b) => b.credentialId !== body.credentialId);
        data.revision = `r${++version}`;
        return { ok: true } as T;
      }
      return structuredClone(data) as T;
    },
    changed: () =>
      render(
        html`<div class="deploy-detail" .inert=${panel.isDialogOpen()}>${panel.section()}</div>
          ${panel.dialog()}`,
        container,
      ),
  });
  return {
    panel,
    requests,
    data,
    fail: (error: Error) => {
      failure = error;
    },
    defer: (fn: () => Promise<unknown>) => {
      pending = fn;
    },
    navigate: () => {
      current = false;
      root.replaceChildren();
    },
  };
}

test("saved-key dialog shows disabled reasons, constraints, default bearer and explicit confirmation; cancel does not mutate", async () => {
  const h = fixture();
  await h.panel.load();
  button("Connect saved key").focus();
  button("Connect saved key").click();
  await tick();
  assert.equal(dom.window.document.activeElement, button("Cancel"));
  assert.equal(root.querySelector<HTMLElement>(".deploy-detail")!.inert, true);
  const disabled = [...root.querySelectorAll<HTMLOptionElement>("option:disabled")].map((option) => option.textContent);
  assert.ok(disabled.some((text) => text?.includes("expired")));
  assert.ok(disabled.some((text) => text?.includes("File logins")));
  assert.ok(disabled.some((text) => text?.includes("Managed OAuth")));
  assert.match(root.textContent!, /Sample account/);
  assert.match(root.textContent!, /owner@example.com/);
  const host = root.querySelector<HTMLInputElement>('input[placeholder="api.example.com"]')!;
  assert.equal(host.value, "api.example.com");
  assert.equal(host.readOnly, true);
  assert.equal(root.querySelector<HTMLSelectElement>("select")!.value, key.id);
  assert.equal(root.querySelectorAll(".deploy-credential-methods input:checked").length, 1);
  assert.match(root.textContent!, /Authorization: Bearer \[API_TOKEN\]/);
  assert.match(root.textContent!, /App viewers can see returned data/);
  assert.match(root.textContent!, /app\s+managers can change the code/);
  assert.equal(button("Connect key").disabled, true);
  button("Cancel").click();
  await tick();
  assert.equal(root.querySelector('[role="dialog"]'), null);
  assert.equal(root.querySelector<HTMLElement>(".deploy-detail")!.inert, false);
  assert.equal(dom.window.document.activeElement, button("Connect saved key"));
  assert.equal(h.requests.filter((r) => r.body).length, 0);
});

test("connect sends chosen fields, paths, methods and the loaded revision; edits reset approval", async () => {
  const h = fixture();
  await h.panel.load();
  button("Connect saved key").click();
  const select = root.querySelector<HTMLSelectElement>("select")!;
  change(select, "paired", "change");
  change(root.querySelector<HTMLTextAreaElement>("textarea")!, "/v1/data\n/v2/stats");
  const headers = root.querySelectorAll<HTMLSelectElement>(".deploy-credential-header select");
  change(headers[0]!, "x-token-id", "change");
  change(root.querySelector<HTMLInputElement>(".deploy-credential-header input")!, "");
  button("Add header").click();
  const second = root.querySelectorAll<HTMLElement>(".deploy-credential-header")[1]!;
  assert.equal(second.querySelectorAll<HTMLSelectElement>("select")[1]!.value, "TOKEN_SECRET");
  change(second.querySelector<HTMLSelectElement>("select")!, "x-token-secret", "change");
  const post = [...root.querySelectorAll<HTMLLabelElement>(".deploy-credential-methods label")]
    .find((label) => label.textContent?.trim() === "POST")!
    .querySelector("input")!;
  post.checked = true;
  post.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  confirm();
  assert.equal(button("Connect key").disabled, false);
  change(root.querySelector<HTMLTextAreaElement>("textarea")!, "/v1/data");
  assert.equal(button("Connect key").disabled, true);
  confirm();
  button("Connect key").click();
  await tick();
  const body = h.requests.find((request) => request.body)?.body;
  assert.deepEqual(body, {
    action: "connect",
    expectedRevision: "r1",
    binding: {
      credentialId: "paired",
      ownerId: key.ownerId,
      host: key.host,
      allowedMethods: ["GET", "POST"],
      allowedPathPrefixes: ["/v1/data"],
      headers: [
        { name: "x-token-id", field: "TOKEN_ID", scheme: "" },
        { name: "x-token-secret", field: "TOKEN_SECRET", scheme: "" },
      ],
    },
  });
  assert.equal(root.querySelector('[role="dialog"]'), null);
  assert.equal(h.requests.length, 3);
  assert.match(root.textContent!, /Paired/);
});

test("revoke sends only one id and revision, preserving other bindings and permitting deleted keys", async () => {
  const h = fixture(true);
  await h.panel.load();
  assert.match(root.textContent!, /Unavailable credential \(deleted-key\)/);
  button("Revoke").click();
  const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!;
  assert.match(dialog.textContent!, /without a redeploy/);
  button("Revoke", dialog).click();
  await tick();
  assert.deepEqual(h.requests.find((request) => request.body)?.body, {
    action: "revoke",
    expectedRevision: "r1",
    credentialId: key.id,
  });
  assert.equal(h.data.credentialBindings.length, 1);
  assert.equal(h.data.credentialBindings[0]!.credentialId, "deleted-key");
  button("Revoke").click();
  button("Revoke", root.querySelector('[role="dialog"]')!).click();
  await tick();
  assert.equal(h.data.credentialBindings.length, 0);
});

test("errors preserve form, conflicts discard stale approval and reload; retry handles read failures", async () => {
  const h = fixture();
  h.fail(new Error("Read failed"));
  await h.panel.load();
  assert.match(root.textContent!, /Read failed/);
  button("Retry").click();
  await tick();
  button("Connect saved key").click();
  confirm();
  h.fail(new Error("Host rejected"));
  button("Connect key").click();
  await tick();
  assert.match(root.querySelector('[role="dialog"]')!.textContent!, /Host rejected/);
  const conflict = Object.assign(new Error("Credentials changed. Review again."), { status: 409 });
  h.fail(conflict);
  button("Connect key").click();
  await tick();
  assert.equal(root.querySelector('[role="dialog"]'), null);
  assert.match(root.textContent!, /Credentials changed/);
  button("Connect saved key").click();
  assert.equal(button("Connect key").disabled, true);
});

test("late load and mutation responses cannot reopen credentials after navigation", async () => {
  for (const mutation of [false, true]) {
    const h = fixture();
    let finish!: (value: unknown) => void;
    if (mutation) {
      await h.panel.load();
      button("Connect saved key").click();
      confirm();
    }
    h.defer(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = mutation ? (button("Connect key").click(), Promise.resolve()) : h.panel.load();
    h.navigate();
    finish(mutation ? { ok: true } : h.data);
    await loading;
    await tick();
    assert.equal(root.childElementCount, 0);
  }
});
