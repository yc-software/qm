import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { appReturnPath, connectorRoutes } from "../src/api/routes/connectors.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

const state = "00000000-0000-4000-8000-000000000000";
const route = connectorRoutes.find((r) => "path" in r && r.path === "/v1/app-return")!;

function visit(path: string): { status: number; location?: string } {
  const sent: { status: number; location?: string } = { status: 0 };
  const res = {
    setHeader() {},
    getHeader() {},
    writeHead: (status: number, headers?: { location?: string }) => Object.assign(sent, { status }, headers),
    end() {},
  } as unknown as ServerResponse;
  void route.handle({ res, url: new URL(path, "https://qm.example") } as unknown as ApiCtx);
  return sent;
}

test("a finished app sign-in reopens the app with its attempt, context and outcome only", () => {
  const start = appReturnPath({ mobileReturn: true, state }, `/settings?composioReturn=${state}&token=secret`)!;
  const done = visit(`${start}&status=success&error=access%20denied&code=abc`);
  assert.equal(done.status, 303);
  const location = new URL(done.location!);
  assert.equal(`${location.protocol}//${location.host}${location.pathname}`, "qm://connection/callback");
  assert.equal(location.searchParams.get("state"), state);
  assert.equal(
    location.searchParams.get("returnTo"),
    `/settings?composioReturn=${state}&status=success&error=access%20denied`,
  );
  assert.equal(appReturnPath({ state }, "/keychain"), "/keychain");
  assert.equal(appReturnPath({ mobileReturn: true }, "/keychain"), null);
  for (const returnTo of ["https://evil.example/", "//evil.example/"])
    assert.equal(visit(`/api/app-return?${new URLSearchParams({ state, returnTo })}`).status, 400);
});
