import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { webFetch } from "../src/core-bridge.ts";
import { currentInAppLocation, SIGNIN_REQUIRED_EVENT, signinRedirect } from "../src/signin-return.ts";

const location = {
  origin: "https://qm.example.com",
  pathname: "/crons/job-1",
  search: "?tab=runs",
  hash: "#output",
};

test("the sign-in redirect preserves the complete in-app location", () => {
  assert.equal(currentInAppLocation(location), "/crons/job-1?tab=runs#output");
  const redirect = signinRedirect("/auth/login", location);
  assert.equal(redirect, "/auth/login?returnTo=%2Fcrons%2Fjob-1%3Ftab%3Druns%23output");
  assert.equal(new URL(redirect!, location.origin).searchParams.get("returnTo"), "/crons/job-1?tab=runs#output");
});

test("only the same-origin sign-in endpoint can initiate the round trip", () => {
  assert.equal(signinRedirect("https://evil.example/auth/login", location), null);
  assert.equal(signinRedirect("//evil.example/auth/login", location), null);
  assert.equal(signinRedirect("/other", location), null);
  assert.equal(signinRedirect(null, location), null);
});

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;
const realEvent = globalThis.Event;

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: realWindow });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: realEvent });
});

function installWindow(): { assigned: string[]; target: EventTarget } {
  const dom = new JSDOM("", { url: `${location.origin}${currentInAppLocation(location)}` });
  const assigned: string[] = [];
  const target = new dom.window.EventTarget();
  Object.assign(target, {
    location: {
      ...location,
      assign(value: string) {
        assigned.push(value);
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: target });
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: dom.window.Event });
  return { assigned, target };
}

test("webFetch redirects a 401 through the same-origin sign-in endpoint", async () => {
  const { assigned, target } = installWindow();
  let signinRequired = 0;
  target.addEventListener(SIGNIN_REQUIRED_EVENT, () => signinRequired++);
  globalThis.fetch = async () => Response.json({ loginUrl: "/auth/login" }, { status: 401 });

  const response = await webFetch("/api/me");

  assert.equal(response.status, 401);
  assert.deepEqual(assigned, ["/auth/login?returnTo=%2Fcrons%2Fjob-1%3Ftab%3Druns%23output"]);
  assert.equal(signinRequired, 0);
});

test("webFetch dispatches the sign-in fallback for an unusable 401 body", async () => {
  const { assigned, target } = installWindow();
  let signinRequired = 0;
  target.addEventListener(SIGNIN_REQUIRED_EVENT, () => signinRequired++);
  globalThis.fetch = async () => new Response("not json", { status: 401 });

  const response = await webFetch("/api/me");

  assert.equal(response.status, 401);
  assert.deepEqual(assigned, []);
  assert.equal(signinRequired, 1);
});

test("webFetch leaves non-401 responses alone", async () => {
  const { assigned, target } = installWindow();
  let signinRequired = 0;
  target.addEventListener(SIGNIN_REQUIRED_EVENT, () => signinRequired++);
  globalThis.fetch = async () => Response.json({ error: "forbidden" }, { status: 403 });

  const response = await webFetch("/api/me");

  assert.equal(response.status, 403);
  assert.deepEqual(assigned, []);
  assert.equal(signinRequired, 0);
});
