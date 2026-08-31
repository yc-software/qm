import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_ARTIFACT_MIME,
  WORKFLOW_ARTIFACT_CARD_RENDERER,
  WorkflowArtifactRegistry,
  createDefaultWorkflowArtifactRegistry,
  safeWorkflowArtifactHref,
  validateWorkflowArtifactCard,
  validateWorkflowArtifactEnvelope,
} from "../src/workflow-artifact-registry.ts";

const envelope = {
  version: 1,
  renderer: "test.summary",
  fallbackText: "Open the original summary.",
  payload: { title: "Quarterly summary" },
} as const;

test("registry registration is instance-scoped, exact, one-use removable, and duplicate-safe", () => {
  const first = new WorkflowArtifactRegistry();
  const second = new WorkflowArtifactRegistry();
  const renderer = {
    type: "test.summary",
    decode: (payload: unknown) => payload as { title: string },
    toCard: (value: { title: string }) => ({ heading: value.title }),
  };
  const unregister = first.register(renderer);
  assert.equal(first.has(renderer.type), true);
  assert.equal(second.has(renderer.type), false);
  assert.throws(() => first.register(renderer), /already registered/);
  assert.deepEqual(first.render(validateWorkflowArtifactEnvelope(envelope), "https://qm.test/chat"), {
    heading: "Quarterly summary",
  });
  unregister();
  unregister();
  assert.equal(first.has(renderer.type), false);
  assert.throws(() => first.render(validateWorkflowArtifactEnvelope(envelope), "https://qm.test/chat"), /unknown/);

  const mutable = { ...renderer, type: "test.mutable" };
  const unregisterMutable = first.register(mutable);
  mutable.type = "test.changed";
  unregisterMutable();
  assert.equal(first.has("test.mutable"), false);
});

test("the production default registry renders the generic actionless card contract", () => {
  const registry = createDefaultWorkflowArtifactRegistry();
  const value = validateWorkflowArtifactEnvelope({
    version: 1,
    renderer: WORKFLOW_ARTIFACT_CARD_RENDERER,
    fallbackText: "Open the original card.",
    payload: {
      heading: "Review ready",
      status: { label: "Prepared", tone: "success" },
      sections: [{ key: "summary", label: "Summary", items: [{ value: "No actions available." }] }],
    },
  });
  assert.deepEqual(registry.render(value, "https://qm.test/chat"), value.payload);
});

test("envelopes require the exact v1 shape and bounded inert JSON payloads", () => {
  assert.equal(validateWorkflowArtifactEnvelope(envelope).renderer, "test.summary");
  for (const hostile of [
    { ...envelope, version: 2 },
    { ...envelope, renderer: "../../dynamic-import" },
    { ...envelope, fallbackText: "" },
    { ...envelope, extra: true },
    { ...envelope, payload: { value: Number.NaN } },
    { ...envelope, payload: { value: "x".repeat(8_193) } },
    { ...envelope, payload: Array.from({ length: 65 }, () => null) },
    { ...envelope, payload: JSON.parse('{"__proto__":{"polluted":true}}') },
  ]) {
    assert.throws(() => validateWorkflowArtifactEnvelope(hostile));
  }
  let deep: unknown = "end";
  for (let index = 0; index < 10; index++) deep = { next: deep };
  assert.throws(() => validateWorkflowArtifactEnvelope({ ...envelope, payload: deep }));
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessor, {
    version: { enumerable: true, value: 1 },
    renderer: { enumerable: true, value: "test.summary" },
    fallbackText: { enumerable: true, value: "fallback" },
    payload: { enumerable: true, get: () => ({}) },
  });
  assert.throws(() => validateWorkflowArtifactEnvelope(accessor));
});

test("card output is independently revalidated after decoder execution", () => {
  const registry = new WorkflowArtifactRegistry();
  registry.register({
    type: "test.summary",
    decode: () => ({ trusted: true }),
    toCard: () => ({
      heading: "Safe",
      sections: [{ key: "details", label: "Details", items: [{ value: "ok", href: "javascript:alert(1)" }] }],
    }),
  });
  assert.throws(() => registry.render(validateWorkflowArtifactEnvelope(envelope), "https://qm.test/chat"));

  const throwing = new WorkflowArtifactRegistry();
  throwing.register({
    type: "test.summary",
    decode: () => {
      throw new Error("decoder failed");
    },
    toCard: () => ({ heading: "unreachable" }),
  });
  assert.throws(
    () => throwing.render(validateWorkflowArtifactEnvelope(envelope), "https://qm.test/chat"),
    /decoder failed/,
  );

  assert.throws(() =>
    validateWorkflowArtifactCard(
      {
        heading: "Duplicate sections",
        sections: [
          { key: "same", label: "One", items: [] },
          { key: "same", label: "Two", items: [] },
        ],
      },
      "https://qm.test/chat",
    ),
  );
  assert.throws(() => validateWorkflowArtifactCard({ heading: "Unknown", onClick: "effect" }, "https://qm.test/chat"));
});

test("links allow same-origin HTTP(S) or credential-free cross-origin HTTPS only", () => {
  const base = "http://qm.test/chat";
  assert.equal(safeWorkflowArtifactHref("/files/one", base), "http://qm.test/files/one");
  assert.equal(safeWorkflowArtifactHref("https://docs.example/path", base), "https://docs.example/path");
  for (const value of [
    "http://docs.example/path",
    "javascript:alert(1)",
    "data:text/html,bad",
    "https://user:secret@docs.example/path",
    "//user:secret@qm.test/path",
  ]) {
    assert.equal(safeWorkflowArtifactHref(value, base), null);
  }
});

test("workflow MIME is an exact versioned transport contract", () => {
  assert.equal(WORKFLOW_ARTIFACT_MIME, "application/vnd.qm.workflow-artifact+json;v=1");
});
