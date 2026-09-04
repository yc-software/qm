import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const X_LINK_TS = "300.1";
const DIRECTIVE = [
  "TRIGGER: any top-level message containing an X/tweet link (x.com, twitter.com, t.co)",
  "ACTION: post ONE short, playful PIRATEY one-liner (vary the wording; include a 🏴‍☠️, ⚓, or ☠️) as a reply in that message's own thread",
  "DON'T: respond piratey to messages without an X link",
  "(per alice, updated 2026-07-01)",
  `!engage !postthread ${X_LINK_TS} Arrr, a fresh dispatch washes up from the X seas! 🏴‍☠️`,
].join("\n");

test("exemplar (piratey X-link): the worker gets the standing order verbatim and threads its reply under the trigger", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-exemplar-pirate-"));
  const built = buildApp(testConfig({ dataDir }));
  built.runtime.start();
  try {
    const container = "C-pirate";
    await built.app.setChannelPolicy(container, DIRECTIVE, "U-alice");

    await built.app.ingestSurfaceEvents(
      [
        {
          container,
          ts: X_LINK_TS,
          authorId: "U-alice",
          authorName: "alice",
          text: "<https://x.com/example/status/1234567890?s=20>",
          createdAt: 1,
        },
      ],
      "slack",
      { name: "qm", mentionId: "UBOT" },
    );

    const deadline = Date.now() + 5_000;
    let pending: any[] = [];
    while (Date.now() < deadline && !pending.length) {
      pending = (await built.deliveries.pending("slack")) as any[];
      if (!pending.length) await sleep(50);
    }
    assert.equal(pending.length, 1, "exactly one pirate reply");
    assert.equal(
      pending[0].destination.target,
      `${container}:${X_LINK_TS}`,
      "threaded under the X link, not top-level",
    );
    assert.match(pending[0].text, /^Arrr/);

    const workerSession = await built.sessions.getByThread(`slack:${container}:ambient:${X_LINK_TS}`);
    assert.ok(workerSession, "the ambient worker ran as its own sub-conversation");
    const entries = await built.sessions.getEntries(workerSession!.id);
    const wake = entries.find(
      (e: any) => e.type === "user" && String((e.payload as any)?.text ?? "").includes("<standing-orders"),
    );
    assert.ok(wake, "the wake carries a standing-orders element");
    const text = String((wake!.payload as any).text);
    for (const line of ["DON'T: respond piratey to messages without an X link", "(per alice, updated 2026-07-01)"]) {
      assert.ok(text.includes(line), `standing order not verbatim in the wake: missing "${line}"`);
    }
  } finally {
    await built.runtime.stop();
  }
});
