import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("Slack onboarding launches directly and verifies connection on return", async () => {
  const h = await harness({ path: "/", welcome: true });
  const previousFetch = globalThis.fetch;
  let status: Record<string, unknown> = { configured: false, installAvailable: true };
  let statusCode = 200;
  let launchCode = 200;
  let releaseStatus: () => void = () => {};
  const initialStatus = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  const launches: RequestInit[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/admin/api/slack-installation") {
      await initialStatus;
      return Response.json(status, { status: statusCode });
    }
    if (String(input) === "/admin/api/slack-installation/start") {
      launches.push(init!);
      return Response.json({ url: "https://slack-service.example/install/launch?ticket=test" }, { status: launchCode });
    }
    return previousFetch(input, init);
  };
  const element = document.createElement("qm-onboarding-slack");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    h.releaseSessions();
    await h.boot();
    document.body.append(element);
    await settle();
    assert.equal(element.querySelector<HTMLButtonElement>("button")!.disabled, true);
    element.querySelector<HTMLButtonElement>("button")!.click();
    assert.equal(launches.length, 0);
    releaseStatus();
    await settle();
    assert.match(element.textContent ?? "", /Add to Slack/);
    assert.doesNotMatch(element.textContent ?? "", /Connected to Slack/);
    let submitted: HTMLFormElement | undefined;
    const popupDocument = document.implementation.createHTMLDocument();
    const createElement = popupDocument.createElement.bind(popupDocument);
    popupDocument.createElement = ((tag: string) => {
      const node = createElement(tag);
      if (tag === "form")
        (node as HTMLFormElement).submit = () => {
          submitted = node as HTMLFormElement;
        };
      return node;
    }) as typeof popupDocument.createElement;
    let closed = false;
    const popup = {
      opener: window,
      document: popupDocument,
      closed: false,
      close() {
        closed = true;
      },
    };
    window.open = () => popup as unknown as Window;
    element.querySelector<HTMLButtonElement>("button")!.click();
    await settle();
    assert.equal(launches.length, 1);
    assert.equal(launches[0].method, "POST");
    assert.deepEqual(JSON.parse(launches[0].body as string), { step: "install" });
    assert.equal(submitted?.method, "post");
    assert.equal(submitted?.action, "https://slack-service.example/install/launch?ticket=test");
    assert.equal(popup.opener, null);
    assert.doesNotMatch(element.textContent ?? "", /Connected to Slack/);
    status = { configured: true, setup: { connected: true } };
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.match(element.textContent ?? "", /Connected to Slack/);
    assert.equal(element.querySelector("button"), null);
    for (const next of [
      { configured: true, setup: { connected: false } },
      { configured: true, setupUnavailable: true },
    ]) {
      status = { ...next, installAvailable: true };
      window.dispatchEvent(new window.Event("focus"));
      await settle();
      assert.doesNotMatch(element.textContent ?? "", /Connected to Slack/);
    }
    statusCode = 503;
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.match(element.textContent ?? "", /Could not check Slack connection/);
    window.open = () => null;
    element.querySelector<HTMLButtonElement>(".welcome-slack")!.click();
    await settle();
    assert.match(element.textContent ?? "", /Allow a new tab/);
    window.open = () => popup as unknown as Window;
    launchCode = 502;
    element.querySelector<HTMLButtonElement>(".welcome-slack")!.click();
    await settle();
    assert.equal(closed, true);
    assert.match(element.textContent ?? "", /Could not start Slack installation/);
    assert.equal(element.querySelector<HTMLButtonElement>(".welcome-slack")!.disabled, false);
    statusCode = 200;
    status = { configured: false };
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    const fallback = { opener: window, location: { href: "" } };
    window.open = () => fallback as unknown as Window;
    const count = launches.length;
    element.querySelector<HTMLButtonElement>(".welcome-slack")!.click();
    await settle();
    assert.equal(fallback.location.href, "/admin/slack-settings?setup=slack");
    assert.equal(launches.length, count);
  } finally {
    releaseStatus();
    element.remove();
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
