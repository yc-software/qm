import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { WORKFLOW_ARTIFACT_MIME, WorkflowArtifactRegistry } from "../src/workflow-artifact-registry.ts";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://qm.test/chats/session-1" });
for (const [name, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
  ShadowRoot: dom.window.ShadowRoot,
  Document: dom.window.Document,
  CSSStyleSheet: dom.window.CSSStyleSheet,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { WorkflowArtifactElement } = await import("../src/workflow-artifact.ts");
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  dom.window.document.body.replaceChildren();
  globalThis.fetch = originalFetch;
});

function response(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      version: 1,
      renderer: "test.summary",
      fallbackText: "Use the original file.",
      payload,
    }),
    { headers: { "content-type": WORKFLOW_ARTIFACT_MIME } },
  );
}

async function settle(element: InstanceType<typeof WorkflowArtifactElement>, selector: string): Promise<Element> {
  for (let index = 0; index < 20; index++) {
    await element.updateComplete;
    const found = element.shadowRoot?.querySelector(selector);
    if (found) return found;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`element did not render ${selector}: ${element.shadowRoot?.textContent ?? "no shadow"}`);
}

test("the declarative card renders hostile strings literally with no effectful controls", async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=true"><script>alert(1)</script> **markdown**';
  const registry = new WorkflowArtifactRegistry();
  registry.register({
    type: "test.summary",
    decode: (value: unknown) => value as { hostile: string },
    toCard: (value) => ({
      heading: value.hostile,
      summary: value.hostile,
      status: { label: "Ready", tone: "success" },
      sections: [{ key: "details", label: "Details", items: [{ label: "Value", value: value.hostile }] }],
      links: [{ label: "Documentation", href: "https://docs.example/workflow" }],
    }),
  });
  globalThis.fetch = async () => response({ hostile });
  const element = new WorkflowArtifactElement();
  element.artifactUrl = "/api/files/artifact-1/content";
  element.originalHref = "/api/files/artifact-1/content";
  element.registry = registry;
  dom.window.document.body.append(element);
  const article = await settle(element, "article");
  await settle(element, "section");
  assert.equal(article.getAttribute("aria-label"), "Workflow artifact");
  assert.match(element.shadowRoot?.textContent ?? "", /<img src=x onerror=/);
  assert.match(element.shadowRoot?.textContent ?? "", /\*\*markdown\*\*/);
  assert.equal(element.shadowRoot?.querySelector("img, script, button, form, input, select, textarea"), null);
  const links = [...(element.shadowRoot?.querySelectorAll("a") ?? [])] as HTMLAnchorElement[];
  assert.equal(links.length, 2);
  assert.equal(links[0]?.href, "https://docs.example/workflow");
  assert.equal(links[1]?.href, "https://qm.test/api/files/artifact-1/content");
  assert.ok(links.every((link) => link.rel === "noopener noreferrer"));
});

test("unknown renderers and decoder failures use bounded fallback text plus the original-file link", async () => {
  globalThis.fetch = async () => response({});
  const unknown = new WorkflowArtifactElement();
  unknown.artifactUrl = "/api/files/artifact-2/content";
  unknown.originalHref = "/api/files/artifact-2/content";
  dom.window.document.body.append(unknown);
  const fallback = await settle(unknown, "p");
  assert.equal(fallback.textContent, "Use the original file.");
  assert.equal(
    unknown.shadowRoot?.querySelector<HTMLAnchorElement>("footer a")?.href,
    "https://qm.test/api/files/artifact-2/content",
  );

  const registry = new WorkflowArtifactRegistry();
  registry.register({
    type: "test.summary",
    decode: () => {
      throw new Error("private decoder detail");
    },
    toCard: () => ({ heading: "never" }),
  });
  const failed = new WorkflowArtifactElement();
  failed.artifactUrl = "/api/files/artifact-3/content";
  failed.originalHref = "/api/files/artifact-3/content";
  failed.registry = registry;
  dom.window.document.body.append(failed);
  assert.equal((await settle(failed, "p")).textContent, "Use the original file.");
  assert.doesNotMatch(failed.shadowRoot?.textContent ?? "", /private decoder detail/);
});

test("network failure is generic and removing the element aborts its in-flight fetch", async () => {
  globalThis.fetch = async () => {
    throw new Error("sensitive upstream failure");
  };
  const failed = new WorkflowArtifactElement();
  failed.artifactUrl = "/api/files/artifact-4/content";
  failed.originalHref = "/api/files/artifact-4/content";
  dom.window.document.body.append(failed);
  assert.equal((await settle(failed, "p")).textContent, "This workflow artifact can’t be displayed.");
  assert.doesNotMatch(failed.shadowRoot?.textContent ?? "", /sensitive upstream failure/);

  let signal: AbortSignal | undefined;
  globalThis.fetch = (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  const pending = new WorkflowArtifactElement();
  pending.artifactUrl = "/api/files/artifact-5/content";
  pending.originalHref = "/api/files/artifact-5/content";
  dom.window.document.body.append(pending);
  await pending.updateComplete;
  assert.equal(signal?.aborted, false);
  pending.remove();
  assert.equal(signal?.aborted, true);
});

test("a superseded response never reaches its decoder even when fetch ignores abort", async () => {
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = () => new Promise<Response>((resolve) => pending.push(resolve));
  let staleDecodes = 0;
  const firstRegistry = new WorkflowArtifactRegistry();
  firstRegistry.register({
    type: "test.summary",
    decode: (value: unknown) => {
      staleDecodes++;
      return value;
    },
    toCard: () => ({ heading: "stale" }),
  });
  const secondRegistry = new WorkflowArtifactRegistry();
  secondRegistry.register({
    type: "test.summary",
    decode: (value: unknown) => value,
    toCard: () => ({
      heading: "current",
      sections: [{ key: "current", label: "Current", items: [{ value: "current" }] }],
    }),
  });
  const element = new WorkflowArtifactElement();
  element.artifactUrl = "/api/files/old/content";
  element.originalHref = "/api/files/old/content";
  element.registry = firstRegistry;
  dom.window.document.body.append(element);
  await element.updateComplete;
  assert.equal(pending.length, 1);
  element.artifactUrl = "/api/files/current/content";
  element.originalHref = "/api/files/current/content";
  element.registry = secondRegistry;
  await element.updateComplete;
  assert.equal(pending.length, 2);
  pending[0]!(response({ title: "old" }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(staleDecodes, 0);
  pending[1]!(response({ title: "current" }));
  await settle(element, "section");
  assert.equal(element.shadowRoot?.querySelector("h3")?.textContent, "current");
});
