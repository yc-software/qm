import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("an ambient turn sees the screenshot on the message that woke it, even with no caption", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-ambient-files-")) }));
  built.runtime.start();
  let fulfilling = true;
  const fulfiller = (async () => {
    while (fulfilling) {
      for (const r of await built.app.pendingContextRequests("slack")) {
        const { blobId, sizeBytes } = await built.blobTransfer.put(PNG);
        await built.app.fulfillContextRequest(r.id, {
          result: { messages: [], file: { blobId, sizeBytes, name: r.query.file!.name!, mimetype: "image/png" } },
        });
      }
      await sleep(20);
    }
  })();
  try {
    const container = "G-screens";
    await built.app.setChannelPolicy(container, "!engage read failed-deploy screenshots", "U-alice");
    await built.app.ingestSurfaceEvents(
      [
        {
          container,
          ts: "500.1",
          authorId: "U-alice",
          authorName: "alice",
          text: "",
          files: [{ fileId: "F1", name: "deploy.png", mimetype: "image/png" }],
          createdAt: 1,
        },
      ],
      "slack",
      { name: "qm", mentionId: "UBOT" },
    );

    let seen = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !seen.includes("[vision")) {
      const worker = await built.sessions.getByThread(`slack:${container}:ambient:500.1`);
      const items = worker ? await built.sessions.getItems(worker.id) : [];
      seen = items.map((e) => (e.kind === "AgentMessage" ? (e.text ?? "") : "")).join("\n");
      await sleep(50);
    }
    assert.match(
      seen,
      /\[vision: 1 image\(s\): image\/png\]/,
      "a caption-less screenshot wakes the turn and reaches it",
    );
  } finally {
    fulfilling = false;
    await fulfiller;
    await built.runtime.stop();
  }
});
