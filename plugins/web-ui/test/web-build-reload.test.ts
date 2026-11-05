import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";

type Page = { reloads: () => number; load: (booted: string) => Promise<Load>; dom: JSDOM };
type Load = { respond: (build: string, method?: string) => Promise<Response> };

let loads = 0;

function page(): Page {
  const virtualConsole = new VirtualConsole();
  let reloads = 0;
  virtualConsole.on("jsdomError", (error) => {
    if (/navigation/i.test(error.message)) reloads++;
  });
  const dom = new JSDOM('<!doctype html><head><meta name="qm-web-build" content="" /></head><body></body>', {
    url: "http://localhost/",
    virtualConsole,
  });
  dom.window.addEventListener("qm:prepare-update", (event) => {
    (event as CustomEvent<{ ready: boolean }>).detail.ready = true;
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    sessionStorage: dom.window.sessionStorage,
    CustomEvent: dom.window.CustomEvent,
  });
  return {
    dom,
    reloads: () => reloads,
    load: async (booted) => {
      dom.window.document.querySelector("meta")!.setAttribute("content", booted);
      const { trackWebBuild } = (await import(
        `../src/web-build.ts?load=${++loads}`
      )) as typeof import("../src/web-build.ts");
      return {
        respond: (build, method = "GET") =>
          trackWebBuild(Promise.resolve(new Response("{}", { headers: { "x-qm-web-build": build } })), method),
      };
    },
  };
}

test("a changed build reloads the page once it settles; the booted build never does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const tab = page();
  const loaded = await tab.load("a");
  await loaded.respond("a");
  t.mock.timers.tick(10_000);
  assert.equal(tab.reloads(), 0);
  await loaded.respond("b");
  t.mock.timers.tick(1_999);
  assert.equal(tab.reloads(), 0);
  t.mock.timers.tick(1);
  assert.equal(tab.reloads(), 1);
  await loaded.respond("b");
  t.mock.timers.tick(10_000);
  assert.equal(tab.reloads(), 1);
});

test("instances answering with alternating builds reload at most once per build until a cool-off passes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const tab = page();
  for (const [booted, served, reloads] of [
    ["a", "b", 1],
    ["b", "a", 2],
    ["a", "b", 2],
    ["b", "a", 2],
  ] as const) {
    const loaded = await tab.load(booted);
    await loaded.respond(served);
    t.mock.timers.tick(10_000);
    assert.equal(tab.reloads(), reloads, `booted ${booted}, served ${served}`);
  }
  t.mock.timers.tick(5 * 60_000);
  const stranded = await tab.load("a");
  await stranded.respond("b");
  t.mock.timers.tick(10_000);
  assert.equal(tab.reloads(), 3, "a tab stranded on the old build retries once the cool-off passes");
});

test("a write in flight, typed text or an unsafe composer defers the reload to the next quiet moment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const tab = page();
  const { trackWebBuild } = (await import(
    `../src/web-build.ts?load=${++loads}`
  )) as typeof import("../src/web-build.ts");
  tab.dom.window.document.querySelector("meta")!.setAttribute("content", "a");
  let finishUpload!: (response: Response) => void;
  const upload = trackWebBuild(new Promise<Response>((resolve) => (finishUpload = resolve)), "POST");
  await trackWebBuild(Promise.resolve(new Response("{}", { headers: { "x-qm-web-build": "b" } })), "GET");
  t.mock.timers.tick(10_000);
  assert.equal(tab.reloads(), 0, "upload still in flight");

  const draft = tab.dom.window.document.createElement("textarea");
  draft.value = "half a thought";
  tab.dom.window.document.body.append(draft);
  finishUpload(new Response("{}", { headers: { "x-qm-web-build": "b" } }));
  await upload;
  t.mock.timers.tick(10_000);
  assert.equal(tab.reloads(), 0, "unsent text on screen");

  draft.value = "";
  const staged = (event: Event) => event.preventDefault();
  tab.dom.window.addEventListener("qm:prepare-update", staged);
  t.mock.timers.tick(10_000);
  assert.equal(tab.reloads(), 0, "composer reports staged work");

  tab.dom.window.removeEventListener("qm:prepare-update", staged);
  t.mock.timers.tick(10_000);
  assert.equal(tab.reloads(), 1);
});
