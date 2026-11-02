import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerWiring, runnableServices } from "../src/services.ts";
import { secretDestinations } from "../src/secrets.ts";

test("slack and auth run inside core, so only core and the egress proxy are deployed", () => {
  assert.deepEqual(runnableServices(["core", "slack", "auth"]), ["core"]);
  assert.deepEqual(runnableServices(["core", "auth", "egress-proxy"]), ["core", "egress-proxy"]);
});

test("the broker stays private inside core and keeps its public issuer and callback", () => {
  const env = brokerWiring({ publicUrl: "https://agent.example.com/", allowedEmailDomain: "example.com" });
  assert.equal(env.AUTH_EMBEDDED, "1");
  assert.equal(env.AUTH_BROKER_UPSTREAM, "http://127.0.0.1:8099");
  assert.equal(env.AUTH_ISSUER, "https://agent.example.com/idp");
  assert.equal(env.OIDC_AUTH_ENDPOINT, "https://agent.example.com/idp/authorize");
  assert.equal(env.AUTH_REDIRECT_URI, "https://agent.example.com/auth/callback");
  assert.equal(env.OIDC_TOKEN_ENDPOINT, "http://127.0.0.1:8099/token");
  assert.equal(env.OIDC_ALLOWED_EMAIL_DOMAIN, "example.com");
  assert.equal(env.AUTH_ALLOWED_EMAIL_DOMAIN, "example.com");
  assert.equal(brokerWiring({ publicUrl: "https://agent.example.com" }).OIDC_ALLOWED_EMAIL_DOMAIN, undefined);
});

test("the broker client secret reaches core under both of its names", () => {
  const destinations = secretDestinations({
    name: "AUTH_CLIENT_SECRET",
    services: ["auth"],
    aliases: [{ service: "core", name: "OIDC_CLIENT_SECRET" }],
    description: "test",
    required: true,
    managedBy: "operator",
  });
  assert.deepEqual([...destinations], [["core", new Set(["AUTH_CLIENT_SECRET", "OIDC_CLIENT_SECRET"])]]);
});
