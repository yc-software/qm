import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { composioAuthorizeRoutes, composioCallbackUrl } from "../src/api/routes/composio-authorize.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

const state = "00000000-0000-4000-8000-000000000000";
test("callbacks stay on the configured public origin and preserve the conversation", () => {
  assert.equal(
    composioCallbackUrl("https://qm.example", "/s/chat?layout=single", state),
    `https://qm.example/s/chat?layout=single&composioReturn=${state}`,
  );
  assert.equal(
    composioCallbackUrl("https://qm.example/web-ui", "/web-ui/s/chat", state),
    `https://qm.example/web-ui/s/chat?composioReturn=${state}`,
  );
  assert.equal(
    composioCallbackUrl("https://qm.example/web-ui", "/web-ui/settings", state),
    `https://qm.example/web-ui/settings?composioReturn=${state}`,
  );
  for (const path of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/admin/",
    "/s/chat/../../auth/logout",
    "/s/chat\n",
  ]) {
    assert.equal(composioCallbackUrl("https://qm.example", path, state), null);
  }
  assert.equal(composioCallbackUrl("https://qm.example", "/", "bad"), null);
});

test("a signed-in browser's invalid return page is refused before any app connection starts", async () => {
  for (const [path, body] of [
    ["/v1/composio/authorize", { toolkit: "gmail", returnTo: "/s/chat" }],
    ["/v1/composio/authorize", { toolkit: "gmail", state }],
    ["/v1/composio/authorize", { toolkit: "gmail", returnTo: null, state: null }],
    ["/v1/composio/authorize", { toolkit: "gmail", returnTo: "https://evil.example", state }],
    ["/v1/composio/authorize", { toolkit: "gmail", returnTo: "/", state: "bad" }],
    ["/v1/composio/slack/authorize", {}],
    ["/v1/composio/slack/authorize", { returnTo: "//evil.example/", state }],
  ] as const) {
    let status = 0;
    let sent = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead: (code: number) => (status = code),
      end: (text: string) => (sent = text),
    } as unknown as ServerResponse;
    const ctx = {
      res,
      body,
      deps: { portalUrl: "https://qm.example" },
      actor: { p: "alice", exp: Date.now() + 60_000 },
    };
    const route = composioAuthorizeRoutes.find((r) => "path" in r && r.path === path)!;
    await route.handle(ctx as unknown as ApiCtx);
    assert.deepEqual(
      [status, JSON.parse(sent)],
      [400, { error: "invalid_return_url" }],
      `${path} ${JSON.stringify(body)}`,
    );
  }
});
