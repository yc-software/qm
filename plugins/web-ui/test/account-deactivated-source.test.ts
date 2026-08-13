import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { reportAccessGate, setSigninRequiredHandler, type SigninRequired } from "../src/core-bridge.ts";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");

test("the web UI distinguishes account deactivation from session expiry", () => {
  assert.match(shell, /Your account is deactivated/);
  assert.match(shell, /portal session is valid/);
  assert.match(shell, /reason === "account_deactivated"/);
  assert.match(bridge, /status === 403/);
  assert.match(bridge, /detail\.error === "account_deactivated"/);
});

test("an error-only deactivation response is normalized before rendering", () => {
  let received: SigninRequired | null = null;
  setSigninRequiredHandler((detail) => {
    received = detail;
  });
  reportAccessGate(403, { error: "account_deactivated" });
  assert.deepEqual(received, { error: "account_deactivated", reason: "account_deactivated" });
});
