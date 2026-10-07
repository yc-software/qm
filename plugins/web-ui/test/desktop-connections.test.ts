import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("desktop connection buttons hand off before creating authorization state", async () => {
  const h = await harness({ path: "/settings", welcome: true });
  const fetchBefore = globalThis.fetch;
  const browserUrls: string[] = [];
  const authorized: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/authorize")) authorized.push(String(input));
    return fetchBefore(input, init);
  };
  try {
    Object.assign(window, {
      qmDesktop: {
        openBrowser: async (url: string) => {
          browserUrls.push(url);
        },
      },
    });
    h.releaseSessions();
    await h.boot();
    const slack = document.querySelector("qm-slack-account")!;
    assert.ok(slack);
    (slack as unknown as { connect(): Promise<void> }).connect();
    const apps = document.querySelector("qm-onboarding-welcome")!;
    assert.ok(apps);
    await (apps as unknown as { authorize(service: { id: string; name: string }): Promise<void> }).authorize({
      id: "gmail",
      name: "Gmail",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(browserUrls, ["/settings", "/settings"]);
    assert.deepEqual(authorized, []);
    assert.equal(sessionStorage.getItem("qm-slack-account"), null);
    assert.equal(sessionStorage.getItem("qm-connection-return:test:tester"), null);
  } finally {
    Reflect.deleteProperty(window, "qmDesktop");
    globalThis.fetch = fetchBefore;
    await h.close();
  }
});
