import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerWiring, hostedServiceEnv, runnableServices } from "../src/services.ts";
import { secretDestinations } from "../src/secrets.ts";

test("five logical components deploy as three services without losing core-only deployments", () => {
  assert.deepEqual(runnableServices(["core", "slack", "web-ui", "admin", "portal", "auth"]), [
    "core",
    "web-ui",
    "portal",
  ]);
  assert.deepEqual(runnableServices(["core"]), ["core"]);
});

test("combined settings preserve component configuration and reject conflicting values", () => {
  assert.deepEqual(hostedServiceEnv(["portal", "auth"], { portal: { A: "1" }, auth: { B: "2" } }, "portal"), {
    A: "1",
    B: "2",
  });
  assert.throws(
    () => hostedServiceEnv(["portal", "auth"], { portal: { A: "1" }, auth: { A: "2" } }, "portal"),
    /Conflicting A/,
  );
});

test("broker stays private inside portal and keeps its public issuer and callback", () => {
  const env = brokerWiring("portal", {
    publicUrl: "https://agent.example.com",
    authBaseUrl: "http://retired-auth:8080",
  });
  assert.equal(env.AUTH_EMBEDDED, "1");
  assert.equal(env.AUTH_BROKER_UPSTREAM, "http://127.0.0.1:8099");
  assert.equal(env.AUTH_ISSUER, "https://agent.example.com/idp");
  assert.equal(env.AUTH_REDIRECT_URI, "https://agent.example.com/auth/callback");
  assert.equal(env.OIDC_TOKEN_ENDPOINT, "http://127.0.0.1:8099/token");
});

test("broker client secret keeps both required names on portal", () => {
  const destinations = secretDestinations({
    name: "AUTH_CLIENT_SECRET",
    services: ["auth"],
    aliases: [{ service: "portal", name: "OIDC_CLIENT_SECRET" }],
    description: "test",
    required: true,
    managedBy: "operator",
  });
  assert.deepEqual([...destinations], [["portal", new Set(["AUTH_CLIENT_SECRET", "OIDC_CLIENT_SECRET"])]]);
});
