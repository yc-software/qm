import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerWiring, hostedServiceEnv, runnableServices } from "../src/services.ts";
import { secretDestinations } from "../src/secrets.ts";

test("every surface but the egress proxy runs inside core", () => {
  assert.deepEqual(runnableServices(["core", "slack", "web-ui", "admin", "portal", "auth"]), ["core"]);
  assert.deepEqual(runnableServices(["core", "portal", "egress-proxy"]), ["core", "egress-proxy"]);
});

test("core absorbs hosted component settings, keeps its own last, and rejects conflicts between them", () => {
  assert.deepEqual(
    hostedServiceEnv(
      ["core", "portal", "auth"],
      { core: { A: "core" }, portal: { A: "portal", B: "1" }, auth: { C: "2" } },
      "core",
    ),
    { A: "core", B: "1", C: "2" },
  );
  assert.throws(
    () => hostedServiceEnv(["core", "portal", "auth"], { portal: { A: "1" }, auth: { A: "2" } }, "core"),
    /Conflicting A settings in services hosted by core/,
  );
  assert.deepEqual(hostedServiceEnv(["core", "auth"], { auth: { A: "1" } }, "egress-proxy"), {});
});

test("broker stays private inside core and keeps its public issuer and callback", () => {
  const env = brokerWiring({ publicUrl: "https://agent.example.com/" });
  assert.equal(env.AUTH_EMBEDDED, "1");
  assert.equal(env.AUTH_BROKER_UPSTREAM, "http://127.0.0.1:8099");
  assert.equal(env.AUTH_ISSUER, "https://agent.example.com/idp");
  assert.equal(env.AUTH_REDIRECT_URI, "https://agent.example.com/auth/callback");
  assert.equal(env.OIDC_TOKEN_ENDPOINT, "http://127.0.0.1:8099/token");
});

test("broker client secret keeps both required names on core", () => {
  const destinations = secretDestinations({
    name: "AUTH_CLIENT_SECRET",
    services: ["auth"],
    aliases: [{ service: "portal", name: "OIDC_CLIENT_SECRET" }],
    description: "test",
    required: true,
    managedBy: "operator",
  });
  assert.deepEqual([...destinations], [["core", new Set(["AUTH_CLIENT_SECRET", "OIDC_CLIENT_SECRET"])]]);
});
