import assert from "node:assert/strict";
import test from "node:test";
import { browserEnv } from "./browser-env.ts";

test("group avatar stack shows photos, initials, the extra class and a +N chip", async () => {
  const env = await browserEnv();
  try {
    const { groupAvatarStackTpl } = await env.vite.ssrLoadModule("/src/group-avatars.ts");
    const { render } = await env.vite.ssrLoadModule("lit");
    const mount = (...args: unknown[]): HTMLElement => {
      const host = document.createElement("div");
      render(groupAvatarStackTpl(...args), host);
      return host;
    };

    const two = mount(
      [
        { principalId: "a", displayName: "Maya", avatarUrl: "https://example.test/maya.png" },
        { principalId: "b", displayName: "theo" },
      ],
      "context-row-avatars",
    );
    const stack = two.querySelector(".group-avatar-stack.context-row-avatars")!;
    assert.equal(stack.getAttribute("aria-label"), "With Maya, theo");
    const [maya, theo] = stack.querySelectorAll(".inbox-avatar");
    assert.equal(maya?.querySelector("img")?.getAttribute("src"), "https://example.test/maya.png");
    assert.equal(theo?.textContent?.trim(), "TH");
    assert.equal(theo?.querySelector("img"), null);
    assert.equal(stack.querySelector(".inbox-avatar.more"), null);

    const four = mount(["A", "B", "C", "D"].map((name) => ({ principalId: name, displayName: name })));
    assert.equal(four.querySelectorAll(".inbox-avatar:not(.more)").length, 2);
    assert.equal(four.querySelector(".inbox-avatar.more")?.textContent?.trim(), "+2");

    assert.equal(mount([]).querySelector(".group-avatar-stack"), null);
  } finally {
    await env.close();
  }
});
