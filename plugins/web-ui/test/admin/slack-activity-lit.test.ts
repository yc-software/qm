import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, tabText } from "./fixture.ts";

const mirror = { "/slack-mirror": { containers: [{ container: "C1", name: "general", kind: "channel" }] } };

test("judgments filter by tab, escape reasons and load earlier pages", async () => {
  const row = (id: number) => ({ id, container: "C1", decision: "act", reason: "<b>x</b>", createdAt: id });
  const f = await mountPage("/settings/judgments", {
    ...mirror,
    "/ambient-judgments": ({ url }) =>
      url.searchParams.get("before")
        ? { judgments: [row(1)], hasMore: false }
        : { judgments: [row(2)], hasMore: true, counts: { act: 3, ignore: 1 } },
  });
  await f.settle();
  assert.equal(f.requests[1]!.url.search, "?decision=act%2Cignore");
  assert.deepEqual([...f.host.querySelectorAll(".resource-tabs a")].map(tabText), [
    "Judged 4",
    "Woke 3",
    "Silent 1",
    "Fastlane 0",
  ]);
  assert.equal(f.host.querySelector(".resource-tabs a")!.getAttribute("href"), "/settings/judgments");
  assert.equal(f.host.querySelector("b"), null);
  assert.equal(f.host.querySelector(".dense-name")!.textContent, "#general");
  f.host.querySelector<HTMLButtonElement>(".load-earlier")!.click();
  await f.settle();
  assert.equal(f.requests.at(-1)!.url.searchParams.get("beforeId"), "2");
  assert.equal(f.host.querySelectorAll(".dense-row").length, 2);
  assert.equal(f.host.querySelector(".load-earlier"), null);
  f.close();
});

test("ack detail renders its message, candidate slate and Slack link", async () => {
  const f = await mountPage("/settings/ackemoji?jid=7", {
    ...mirror,
    "/ack-emoji-picks": {
      pick: {
        id: 7,
        channel: "C1",
        ts: "1.2",
        outcome: "picked",
        picked: "eyes",
        candidates: "eyes tada",
        message: "hi",
      },
      workspaceUrl: "https://acme.slack.com/",
    },
  });
  await f.settle();
  assert.equal(f.requests.at(-1)!.url.search, "?id=7");
  assert.equal(f.host.querySelector(".judg-prompt")!.textContent, "hi");
  assert.equal(f.host.querySelectorAll(".badges .pill").length, 3);
  assert.equal(
    f.host.querySelector<HTMLAnchorElement>(".judg-extlink")!.href,
    "https://acme.slack.com/archives/C1/p12",
  );
  f.close();
});
