import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Harness } from "./deep-link-boot-fixture.ts";

async function waitForText(h: Harness, text: RegExp): Promise<void> {
  for (let i = 0; i < 100 && !text.test(h.mainText()); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(h.mainText(), text);
}

test("real connection return survives router normalization and retires after verification", async () => {
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=success&connectedAccountId=ca_test",
    welcome: true,
    connectionReturn: true,
  });
  try {
    await h.boot();
    await waitForText(h, /Gmail connected/);
    assert.equal(new URLSearchParams(location.search).has("composioReturn"), false);
    assert.equal(sessionStorage.getItem("qm-connection-return:test:tester"), null);
    assert.equal(document.querySelector("qm-onboarding-welcome.welcome-rolling"), null);
    assert.equal((document.querySelector('input[type="search"]') as HTMLInputElement)?.value, "mail");
    const original = document.querySelector("qm-onboarding-welcome")!;
    const replacement = document.createElement("qm-onboarding-welcome");
    Object.assign(replacement, { me: { org: "test", user: "tester" }, base: "/", animateWelcome: true });
    original.replaceWith(replacement);
    await waitForText(h, /Gmail connected/);
    assert.equal((document.querySelector('input[type="search"]') as HTMLInputElement)?.value, "mail");
    h.setConnections([]);
    const remounted = document.createElement("qm-onboarding-welcome");
    Object.assign(remounted, { me: { org: "test", user: "tester" }, base: "/", animateWelcome: true });
    replacement.replaceWith(remounted);
    window.dispatchEvent(new Event("focus"));
    for (let i = 0; i < 100 && /Gmail connected/.test(h.mainText()); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.doesNotMatch(h.mainText(), /Gmail connected|Couldn’t connect/);
  } finally {
    await h.close();
  }
});
