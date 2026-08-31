import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_ARTIFACT_MIME } from "../src/workflow-artifact-registry.ts";
import {
  WORKFLOW_ARTIFACT_MAX_BYTES,
  fetchWorkflowArtifact,
  isWorkflowArtifactMime,
} from "../src/workflow-artifact.ts";

const url = "https://qm.test/api/files/artifact-1/content";
const base = "https://qm.test/chats/session-1";
const body = JSON.stringify({
  version: 1,
  renderer: "test.summary",
  fallbackText: "Open the file.",
  payload: { title: "Summary" },
});

function artifactResponse(value = body, headers: Record<string, string> = {}): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": WORKFLOW_ARTIFACT_MIME, ...headers },
  });
}

test("fetch uses only the authenticated same-origin file route with no-store and redirect refusal", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return artifactResponse();
  };
  const signal = new AbortController().signal;
  const parsed = await fetchWorkflowArtifact(url, base, signal, fetcher);
  assert.equal(parsed.renderer, "test.summary");
  assert.equal(seenUrl, url);
  assert.equal(seenInit?.method, "GET");
  assert.equal(seenInit?.cache, "no-store");
  assert.equal(seenInit?.credentials, "same-origin");
  assert.equal(seenInit?.redirect, "error");
  assert.equal(seenInit?.signal, signal);
  await assert.rejects(() => fetchWorkflowArtifact("https://evil.test/api/files/a/content", base, signal, fetcher));
  await assert.rejects(() =>
    fetchWorkflowArtifact("https://qm.test/unrelated/api/files/a/content", base, signal, fetcher),
  );
  await assert.rejects(() =>
    fetchWorkflowArtifact("https://qm.test/api/files/a/content?next=evil", base, signal, fetcher),
  );
});

test("fetch rejects redirects, MIME variants, invalid UTF-8, and malformed JSON", async () => {
  const signal = new AbortController().signal;
  const redirected = artifactResponse();
  Object.defineProperties(redirected, {
    redirected: { value: true },
    url: { value: "https://qm.test/api/files/other/content" },
  });
  await assert.rejects(() => fetchWorkflowArtifact(url, base, signal, async () => redirected), /fetch failed/);
  assert.equal(
    (
      await fetchWorkflowArtifact(url, base, signal, async () =>
        artifactResponse(body, { "content-type": `${WORKFLOW_ARTIFACT_MIME}; charset=utf-8` }),
      )
    ).renderer,
    "test.summary",
  );
  for (const contentType of [
    `${WORKFLOW_ARTIFACT_MIME}; charset=iso-8859-1`,
    `${WORKFLOW_ARTIFACT_MIME}; charset=utf-8; profile=unexpected`,
    "application/vnd.qm.workflow-artifact+json; charset=utf-8",
  ]) {
    await assert.rejects(() =>
      fetchWorkflowArtifact(url, base, signal, async () => artifactResponse(body, { "content-type": contentType })),
    );
  }
  await assert.rejects(() =>
    fetchWorkflowArtifact(
      url,
      base,
      signal,
      async () => new Response(Uint8Array.from([0xc3, 0x28]), { headers: { "content-type": WORKFLOW_ARTIFACT_MIME } }),
    ),
  );
  await assert.rejects(() => fetchWorkflowArtifact(url, base, signal, async () => artifactResponse("{")));
});

test("fetch enforces the 128 KiB cap from headers and streamed bytes", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(() =>
    fetchWorkflowArtifact(url, base, signal, async () =>
      artifactResponse(body, { "content-length": String(WORKFLOW_ARTIFACT_MAX_BYTES + 1) }),
    ),
  );
  await assert.rejects(() =>
    fetchWorkflowArtifact(
      url,
      base,
      signal,
      async () =>
        new Response(new Uint8Array(WORKFLOW_ARTIFACT_MAX_BYTES + 1), {
          headers: { "content-type": WORKFLOW_ARTIFACT_MIME },
        }),
    ),
  );
  await assert.rejects(() =>
    fetchWorkflowArtifact(url, base, signal, async () => artifactResponse(body, { "content-length": "NaN" })),
  );
});

test("ordinary and near-match MIME files remain outside the workflow renderer", () => {
  assert.equal(isWorkflowArtifactMime(WORKFLOW_ARTIFACT_MIME), true);
  for (const mime of [
    "application/json",
    "application/vnd.qm.workflow-artifact+json",
    `${WORKFLOW_ARTIFACT_MIME};charset=utf-8`,
    "image/png",
    undefined,
  ]) {
    assert.equal(isWorkflowArtifactMime(mime), false);
  }
});
