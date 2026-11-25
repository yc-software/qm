import assert from "node:assert/strict";
import test from "node:test";
import { connectWidget, harness, settle } from "./deep-link-boot-fixture.ts";

test("a card for one app asks for that app alone and never shows the person's other apps", async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const asked: string[] = [];
  const h = await harness({
    path: "/s/sess-deep",
    api: (path) => {
      if (path.startsWith("/api/composio/connections"))
        return held.then(() =>
          Response.json({
            items: [
              { id: "ca_teams", toolkit: "microsoft_teams", missingScopes: ["offline_access"] },
              { id: "ca_point", toolkit: "share_point", missingScopes: [] },
            ],
            nextCursor: null,
          }),
        );
      if (!path.startsWith("/api/composio/toolkits")) return undefined;
      asked.push(new URL(path, "http://localhost").searchParams.get("toolkit") ?? "");
      return held.then(() =>
        Response.json({ items: [{ id: "gmail", name: "Gmail", description: "Email" }], nextCursor: null }),
      );
    },
  });
  try {
    await h.boot();
    const widget = connectWidget();
    await settle(() => Boolean(widget.querySelector(".connection-card")));
    const waiting = widget.querySelector(".connection-card")!;
    assert.ok(waiting.querySelector('.connector-logo[data-service="gmail"]'), "the logo is there from the first frame");
    assert.ok(waiting.classList.contains("pending"), "the card is dimmed until the check resolves");
    assert.equal(waiting.querySelector<HTMLButtonElement>(".btn.primary")?.disabled, true);
    const layout = (card: Element) => [
      [...card.classList].filter((look) => look !== "pending"),
      [...card.querySelectorAll("*")].map((node) => node.localName),
    ];
    const before = layout(waiting);
    release();
    await settle(() => !widget.querySelector(".connection-card.pending"));
    const card = widget.querySelector(".connection-card")!;
    assert.deepEqual(layout(card), before, "the check resolves in place without changing the card's layout");
    assert.equal(card.querySelector(".connection-card-status")?.textContent?.trim(), "Not connected");
    assert.equal(widget.querySelector(".connection-card strong")?.textContent, "Gmail");
    assert.equal(widget.querySelector(".connection-card .btn.primary")?.getAttribute("aria-label"), "Connect Gmail");
    assert.equal(widget.querySelector(".connection-card .btn:not(.primary)"), null);
    assert.equal(widget.querySelectorAll(".connection-card button").length, 1);
    assert.equal(widget.querySelector(".connection-picker"), null);
    assert.equal(widget.querySelector(".connection-connected"), null);
    assert.deepEqual(asked, ["gmail"]);
  } finally {
    await h.close();
  }
});
