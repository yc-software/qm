import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

for (const kind of ["channel", "group"] as const) {
  for (const sub of [undefined, "200.1"]) {
    test(`solicited ${kind} ${sub ? "thread" : "root"} keeps posts, progress and later replies threaded`, async () => {
      const built = buildApp(testConfig());
      built.runtime.start();
      try {
        const container = "C-routing";
        await built.directory.replace([
          { principalId: "user-1", displayName: "Asker", type: "internal", slackId: "U1" },
        ]);
        if (kind === "group") {
          await built.directory.replaceGroups([{ groupId: container, principalId: "user-1" }]);
        } else {
          await built.directory.replaceChannels(
            [{ channelId: container, name: "routing", isPrivate: false }],
            [{ channelId: container, principalId: "user-1" }],
          );
        }
        await built.app.setChannelPolicy(container, "!engage-asked", "U-admin");
        const waitFor = async (text: string) => {
          for (let i = 0; i < 100; i++) {
            const delivery = (await built.deliveries.pending("slack")).find((d) => d.text === text);
            if (delivery) return delivery;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.fail(`missing delivery: ${text}`);
        };
        const root = sub ?? "300.1";
        await built.app.ingestSurfaceEvents([
          {
            container,
            ts: "300.1",
            ...(sub ? { sub } : {}),
            authorId: "U1",
            text: "!post first reply",
            kind,
            createdAt: 1,
          },
        ]);
        const first = await waitFor("first reply");
        assert.equal(first.destination.target, `${container}:${root}`);
        await built.app.ingestSurfaceEvents([
          { container, ts: "300.2", sub: root, authorId: "U1", text: "!preamble Checking.", kind, createdAt: 2 },
        ]);
        const progress = await waitFor("Checking.");
        const final = await waitFor("All clear — nothing broke.");
        assert.equal(progress.destination.target, `${container}:${root}`);
        assert.equal(final.destination.target, `${container}:${root}`);
        await built.app.ingestSurfaceEvents([
          { container, ts: "300.3", sub: root, authorId: "U1", text: "!post later reply", kind, createdAt: 3 },
        ]);
        const later = await waitFor("later reply");
        assert.equal(later.destination.target, `${container}:${root}`);
      } finally {
        await built.runtime.stop();
      }
    });
  }
}
