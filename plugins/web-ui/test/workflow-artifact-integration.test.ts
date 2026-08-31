import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { entriesToMessages, type AssistantWork, type SessionEntry } from "../src/core-bridge.ts";
import {
  WORKFLOW_ARTIFACT_CARD_RENDERER,
  WORKFLOW_ARTIFACT_MIME,
  createDefaultWorkflowArtifactRegistry,
} from "../src/workflow-artifact-registry.ts";

test("history replay preserves workflow artifact identity", () => {
  const entries: SessionEntry[] = [
    {
      type: "delivery",
      seq: 1,
      createdAt: 1,
      payload: {
        files: [
          {
            name: "summary.workflow.json",
            mimetype: WORKFLOW_ARTIFACT_MIME,
            sizeBytes: 512,
            artifactId: "artifact-history-1",
          },
        ],
      },
    },
  ];
  const model = { api: "openai-responses", provider: "openai", id: "test" } as never;
  const messages = entriesToMessages(entries, model);
  const delivered = (messages[0] as AssistantWork).deliveredFiles;
  assert.deepEqual(delivered, [
    {
      name: "summary.workflow.json",
      mimetype: WORKFLOW_ARTIFACT_MIME,
      sizeBytes: 512,
      artifactId: "artifact-history-1",
    },
  ]);
});

test("the rendered delivery path handles workflow, cached, image, document, and metadata-only files", async () => {
  const dom = new JSDOM("<!doctype html><body><main></main></body>", { url: "https://qm.test/chats/session-1" });
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
  const [{ render }, { deliveredFileBadge }] = await Promise.all([import("lit"), import("../src/delivered-file.ts")]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        version: 1,
        renderer: WORKFLOW_ARTIFACT_CARD_RENDERER,
        fallbackText: "Open the original file.",
        payload: {
          heading: "Review ready",
          sections: [{ key: "summary", label: "Summary", items: [{ label: "State", value: "Prepared" }] }],
        },
      }),
      { headers: { "content-type": WORKFLOW_ARTIFACT_MIME } },
    );
  try {
    const host = dom.window.document.querySelector<HTMLElement>("main")!;
    const registry = createDefaultWorkflowArtifactRegistry();
    const workflowTemplate = deliveredFileBadge(
      {
        name: "review.workflow.json",
        mimetype: WORKFLOW_ARTIFACT_MIME,
        sizeBytes: 400,
        artifactId: "workflow-1",
      },
      registry,
    );
    render(workflowTemplate, host);
    const workflow = host.querySelector("qm-workflow-artifact")!;
    for (let index = 0; index < 20 && !workflow.shadowRoot?.querySelector("section"); index++) {
      await (workflow as { updateComplete: Promise<boolean> }).updateComplete;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(workflow.shadowRoot?.querySelector("h3")?.textContent, "Review ready");
    assert.equal(workflow.shadowRoot?.querySelector("article")?.getAttribute("aria-live"), "polite");
    assert.equal(workflow.shadowRoot?.querySelector("article")?.getAttribute("aria-busy"), "false");
    assert.match(workflow.shadowRoot?.textContent ?? "", /@container \(max-width: 480px\)/);
    render(workflowTemplate, host);
    assert.equal(host.querySelector("qm-workflow-artifact"), workflow);

    render(
      deliveredFileBadge(
        {
          name: "near-match.json",
          mimetype: `${WORKFLOW_ARTIFACT_MIME};charset=utf-8`,
          artifactId: "ordinary-1",
        },
        registry,
      ),
      host,
    );
    assert.equal(host.querySelector("qm-workflow-artifact"), null);
    assert.equal(host.querySelector("a.file-chip")?.textContent?.trim(), "near-match.json");

    render(deliveredFileBadge({ name: "image.png", mimetype: "image/png", artifactId: "image-1" }, registry), host);
    assert.equal(host.querySelector<HTMLImageElement>("a.file-image img")?.alt, "image.png");
    assert.equal(
      host.querySelector<HTMLImageElement>("a.file-image img")?.src,
      "https://qm.test/api/files/image-1/content",
    );

    render(deliveredFileBadge({ name: "pending.txt", mimetype: "text/plain" }, registry), host);
    assert.equal(host.querySelector("span.file-chip")?.textContent?.trim(), "pending.txt");
    assert.equal(host.querySelector("a"), null);
  } finally {
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("chat uses the behavior-tested delivered-file renderer and default registry", () => {
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  assert.match(chat, /dependencies\.workflowArtifacts \?\? createDefaultWorkflowArtifactRegistry\(\)/);
  assert.match(chat, /files\.map\(\(f\) => deliveredFileBadge\(f, workflowArtifacts\)\)/);
});
