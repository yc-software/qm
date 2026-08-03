import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { JSDOM } from "jsdom";
import { runApprovalTurn } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

function fakeAgent(): Agent {
  return {
    state: {
      model: MODEL,
      messages: [{ role: "user", content: "resolve merge conflicts on this branch" }],
      isStreaming: false,
    },
  } as unknown as Agent;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

function stubTurn(result: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/turn") && init?.method === "POST") {
      return jsonResponse({ status: "queued", runId: "r-1" });
    }
    if (url.includes("/api/runs/r-1")) {
      return jsonResponse({ status: "done", result, partial: "" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function setPageLocale(selected: "en" | "ja"): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM(`<meta name="qm-locale" content="${selected}">`).window.document,
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete (globalThis as { document?: Document }).document;
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a refused approval resume rejects with the refusal reason", async () => {
  const restore = setPageLocale("ja");
  try {
    stubTurn({ status: "refused", reason: "session busy (another turn is in progress)" });
    await assert.rejects(
      runApprovalTurn(
        "web:u:t",
        fakeAgent(),
        { requestId: "a-1", approved: true, scope: "once" },
        undefined,
        undefined,
      ),
      { message: "session busy (another turn is in progress)" },
    );
  } finally {
    restore();
  }
});

test("an approval failure without a server reason uses the localized app fallback", async () => {
  const restore = setPageLocale("ja");
  try {
    stubTurn({ status: "failed" });
    await assert.rejects(
      runApprovalTurn(
        "web:u:t",
        fakeAgent(),
        { requestId: "a-1", approved: true, scope: "once" },
        undefined,
        undefined,
      ),
      { message: "承認を送信できませんでした。" },
    );
  } finally {
    restore();
  }
});

test("a completed approval resume resolves quietly", async () => {
  stubTurn({ status: "ok", reply: "done — pushed." });
  await runApprovalTurn(
    "web:u:t",
    fakeAgent(),
    { requestId: "a-1", approved: true, scope: "session" },
    undefined,
    undefined,
  );
});

test("a denied approval's refusal is a clean outcome, not an error", async () => {
  stubTurn({ status: "refused", reason: "approval denied for git push --force" });
  await runApprovalTurn("web:u:t", fakeAgent(), { requestId: "a-1", approved: false }, undefined, undefined);
});
