import assert from "node:assert/strict";
import test from "node:test";
import { harness, type Harness } from "./deep-link-boot-fixture.ts";

type Handler = (url: string, init?: RequestInit) => Response | null;

let sharedHarness: Harness | null = null;

async function getHarness() {
  if (!sharedHarness) {
    sharedHarness = await harness({ path: "/" });
    sharedHarness.releaseSessions();
    await sharedHarness.boot();
  }
  return sharedHarness;
}

test.after(async () => {
  if (sharedHarness) {
    await sharedHarness.close();
    sharedHarness = null;
  }
});

async function mount(opts: { status: Record<string, unknown>; handler?: Handler; user?: string }) {
  await getHarness();
  document.body.innerHTML = "";
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const hit = opts.handler?.(url, init) ?? null;
    if (hit) {
      calls.push({ method, url, ...(init?.body ? { body: String(init.body) } : {}) });
      return hit;
    }
    if (url.endsWith("/api/discord/link") && method === "GET") return Response.json(opts.status);
    return previousFetch(input, init);
  };
  sessionStorage.removeItem("qm-discord-account");
  history.replaceState(null, "", "http://localhost/");
  const el = document.createElement("qm-discord-account") as HTMLElement & {
    user: string;
    navigate: (u: string) => void;
  };
  el.user = opts.user ?? "test:tester";
  const navigated: string[] = [];
  el.navigate = (u) => void navigated.push(u);
  document.body.append(el);
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  return {
    el,
    calls,
    navigated,
    until,
    restore: () => {
      globalThis.fetch = previousFetch;
      el.remove();
      sessionStorage.removeItem("qm-discord-account");
    },
  };
}

const AUTH_URL =
  "https://discord.com/oauth2/authorize?client_id=4242&state=signed-state&redirect_uri=http%3A%2F%2Flocalhost%2Fsettings";

test("connect verifies Discord's URL, remembers the attempt and navigates", async () => {
  const m = await mount({
    status: { available: true, linked: false, canUnlink: false },
    handler: (url, init) =>
      url.endsWith("/api/discord/link/authorize") && init?.method === "POST" ? Response.json({ url: AUTH_URL }) : null,
  });
  try {
    await m.until(() => Boolean(m.el.querySelector("button")));
    (m.el.querySelector("button") as HTMLButtonElement).click();
    await m.until(() => m.navigated.length > 0);
    assert.deepEqual(m.navigated, [AUTH_URL]);
    const stored = JSON.parse(sessionStorage.getItem("qm-discord-account")!);
    assert.equal(stored.user, "test:tester");
    assert.equal(stored.state, "signed-state");
    assert.equal(typeof stored.nonce, "string");
    assert.ok(stored.nonce.length >= 32);
    assert.ok(stored.expiresAt > Date.now());

    const authorizeCall = m.calls.find((c) => c.url.endsWith("/api/discord/link/authorize"));
    assert.ok(authorizeCall);
    const body = JSON.parse(authorizeCall.body!);
    assert.equal(typeof body.nonceHash, "string");
    assert.match(body.nonceHash, /^[0-9a-f]{64}$/);
    assert.equal(body.nonce, undefined);
    assert.equal(m.navigated[0]?.includes(stored.nonce), false);
  } finally {
    m.restore();
  }
});

test("bad authorize URLs are refused", async () => {
  const badUrls = [
    "http://discord.com/oauth2/authorize?state=x&redirect_uri=http%3A%2F%2Flocalhost%2Fsettings",
    "https://evil.example/oauth2/authorize?state=x&redirect_uri=http%3A%2F%2Flocalhost%2Fsettings",
    "https://sub.discord.com/oauth2/authorize?state=x&redirect_uri=http%3A%2F%2Flocalhost%2Fsettings",
    "https://user:pass@discord.com/oauth2/authorize?state=x&redirect_uri=http%3A%2F%2Flocalhost%2Fsettings",
    "https://discord.com/oauth2/authorize?client_id=4242&redirect_uri=http%3A%2F%2Flocalhost%2Fsettings",
  ];
  for (const badUrl of badUrls) {
    const m = await mount({
      status: { available: true, linked: false, canUnlink: false },
      handler: (url, init) =>
        url.endsWith("/api/discord/link/authorize") && init?.method === "POST" ? Response.json({ url: badUrl }) : null,
    });
    try {
      await m.until(() => Boolean(m.el.querySelector("button")));
      (m.el.querySelector("button") as HTMLButtonElement).click();
      await m.until(() => /verify/.test(m.el.textContent ?? ""));
      assert.deepEqual(m.navigated, []);
      assert.equal(sessionStorage.getItem("qm-discord-account"), null);
    } finally {
      m.restore();
    }
  }
});

test("a wrong path is refused", async () => {
  const m = await mount({
    status: { available: true, linked: false, canUnlink: false },
    handler: (url, init) =>
      url.endsWith("/api/discord/link/authorize") && init?.method === "POST"
        ? Response.json({
            url: "https://discord.com/api/oauth2/authorize?state=x&redirect_uri=http%3A%2F%2Flocalhost%2Fsettings",
          })
        : null,
  });
  try {
    await m.until(() => Boolean(m.el.querySelector("button")));
    (m.el.querySelector("button") as HTMLButtonElement).click();
    await m.until(() => /verify/.test(m.el.textContent ?? ""));
    assert.deepEqual(m.navigated, []);
    assert.equal(sessionStorage.getItem("qm-discord-account"), null);
  } finally {
    m.restore();
  }
});

test("a wrong redirect_uri is refused", async () => {
  const badRedirects = [
    "https://discord.com/oauth2/authorize?state=x&redirect_uri=https%3A%2F%2Fevil.example%2Fsettings",
    "https://discord.com/oauth2/authorize?state=x&redirect_uri=http%3A%2F%2Flocalhost%2Fother",
    "https://discord.com/oauth2/authorize?state=x",
  ];
  for (const url of badRedirects) {
    const m = await mount({
      status: { available: true, linked: false, canUnlink: false },
      handler: (u, init) =>
        u.endsWith("/api/discord/link/authorize") && init?.method === "POST" ? Response.json({ url }) : null,
    });
    try {
      await m.until(() => Boolean(m.el.querySelector("button")));
      (m.el.querySelector("button") as HTMLButtonElement).click();
      await m.until(() => /verify/.test(m.el.textContent ?? ""));
      assert.deepEqual(m.navigated, []);
      assert.equal(sessionStorage.getItem("qm-discord-account"), null);
    } finally {
      m.restore();
    }
  }
});

test("a self-linked user can disconnect; an admin link shows no Disconnect", async () => {
  const self = await mount({
    status: { available: true, linked: true, canUnlink: true, tag: "ana_d" },
    handler: (url, init) =>
      url.endsWith("/api/discord/link") && init?.method === "DELETE" ? Response.json({ linked: false }) : null,
  });
  try {
    await self.until(() => /Connected as ana_d/.test(self.el.textContent ?? ""));
    (self.el.querySelector("button") as HTMLButtonElement).click();
    await self.until(() => self.calls.some((c) => c.method === "DELETE"));
  } finally {
    self.restore();
  }
  const admin = await mount({ status: { available: true, linked: true, canUnlink: false, tag: "ana_d" } });
  try {
    await admin.until(() => /administrator/.test(admin.el.textContent ?? ""));
    assert.equal(admin.el.querySelector("button"), null);
  } finally {
    admin.restore();
  }
});

test("unavailable and unlinked renders nothing", async () => {
  const m = await mount({
    status: { available: false, linked: false, canUnlink: false },
    handler: (url, init) =>
      url.endsWith("/api/discord/link") && (init?.method ?? "GET") === "GET"
        ? Response.json({ available: false, linked: false, canUnlink: false })
        : null,
  });
  try {
    await m.until(() => m.calls.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(m.el.querySelector("section"), null);
    assert.equal((m.el.textContent ?? "").trim(), "");
  } finally {
    m.restore();
  }
});

test("disconnecting while linking is unavailable leaves nothing rendered", async () => {
  let disconnected = false;
  const m = await mount({
    status: {},
    handler: (url, init) => {
      const method = init?.method ?? "GET";
      if (!url.endsWith("/api/discord/link")) return null;
      if (method === "DELETE") {
        disconnected = true;
        return Response.json({ linked: false });
      }
      return Response.json(
        disconnected
          ? { available: false, linked: false, canUnlink: false }
          : { available: false, linked: true, canUnlink: true, tag: "ana_d" },
      );
    },
  });
  try {
    await m.until(() => Boolean(m.el.querySelector("button")));
    (m.el.querySelector("button") as HTMLButtonElement).click();
    await m.until(() => disconnected);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(m.el.querySelector("section"), null);
    assert.equal((m.el.textContent ?? "").trim(), "");
  } finally {
    m.restore();
  }
});

test("disconnect errors show clear messages", async () => {
  const cases = [
    {
      body: { error: "link_unavailable" },
      expected: "Discord linking isn't set up. Ask an administrator.",
    },
    {
      body: { message: "Server refused to disconnect." },
      expected: "Server refused to disconnect.",
    },
    {
      body: { error: "unknown_error" },
      expected: "Couldn't disconnect. Try again.",
    },
  ];
  for (const c of cases) {
    const m = await mount({
      status: { available: true, linked: true, canUnlink: true, tag: "ana_d" },
      handler: (url, init) =>
        url.endsWith("/api/discord/link") && init?.method === "DELETE" ? Response.json(c.body, { status: 400 }) : null,
    });
    try {
      await m.until(() => Boolean(m.el.querySelector("button")));
      (m.el.querySelector("button") as HTMLButtonElement).click();
      await m.until(() => (m.el.textContent ?? "").includes(c.expected));
      assert.ok(m.el.textContent?.includes(c.expected));
    } finally {
      m.restore();
    }
  }
});

test("in the desktop app connect hands off to the system browser and starts no authorization", async () => {
  const opened: string[] = [];
  (window as unknown as { qmDesktop: unknown }).qmDesktop = {
    openBrowser: async (url: string) => void opened.push(url),
  };
  const m = await mount({ status: { available: true, linked: false, canUnlink: false } });
  try {
    await m.until(() => Boolean(m.el.querySelector("button")));
    (m.el.querySelector("button") as HTMLButtonElement).click();
    await m.until(() => opened.length > 0);
    assert.deepEqual(opened, ["/settings"]);
    assert.equal(
      m.calls.some((c) => c.url.endsWith("/api/discord/link/authorize")),
      false,
    );
    assert.deepEqual(m.navigated, []);
  } finally {
    delete (window as unknown as { qmDesktop?: unknown }).qmDesktop;
    m.restore();
  }
});

test("returning focus to the window refreshes the link status", async () => {
  let linked = false;
  const m = await mount({
    status: { available: true, linked: false, canUnlink: false },
    handler: (url, init) =>
      url.endsWith("/api/discord/link") && (init?.method ?? "GET") === "GET" && linked
        ? Response.json({ available: true, linked: true, canUnlink: true, tag: "ana_d" })
        : null,
  });
  try {
    await m.until(() => Boolean(m.el.querySelector("button")));
    linked = true;
    window.dispatchEvent(new window.Event("focus"));
    await m.until(() => /Connected as ana_d/.test(m.el.textContent ?? ""));
    assert.match(m.el.textContent ?? "", /Connected as ana_d/);
  } finally {
    m.restore();
  }
});
