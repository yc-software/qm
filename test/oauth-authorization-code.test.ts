import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeAuthorizationCode, type FetchLike } from "../src/connectors/oauth.ts";

const client = { id: "app", secret: "shh", clientRef: "test" };

test("exchangeAuthorizationCode posts the standard code grant to the given token url", async () => {
  const seen: Array<{ url: string; form: URLSearchParams; contentType: string | undefined }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, form: new URLSearchParams(init.body), contentType: init.headers["content-type"] });
    return Response.json({ access_token: "tok", scope: "identify" });
  };
  const token = await exchangeAuthorizationCode("https://idp.example/token", "the-code", "https://app.example/cb", {
    client,
    fetchImpl,
  });
  assert.equal(token.accessToken, "tok");
  assert.equal(seen[0]!.url, "https://idp.example/token");
  assert.equal(seen[0]!.contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(seen[0]!.form), {
    grant_type: "authorization_code",
    code: "the-code",
    redirect_uri: "https://app.example/cb",
    client_id: "app",
    client_secret: "shh",
  });
});

test("exchangeAuthorizationCode rejects a non-ok token response with its status", async () => {
  const fetchImpl: FetchLike = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  await assert.rejects(
    exchangeAuthorizationCode("https://idp.example/token", "c", "https://app.example/cb", { client, fetchImpl }),
    /token exchange failed \(400\): invalid_grant/,
  );
});
