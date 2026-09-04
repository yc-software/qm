import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeUrl,
  exchangeCode,
  makeRefresh,
  openOAuthState,
  sealOAuthState,
  createSecretClientResolver,
  scopesFor,
  generateCodeVerifier,
  codeChallengeS256,
  PROVIDERS,
  type FetchLike,
  type ResolvedClient,
} from "../src/connectors/oauth.ts";
import { createEnvSecretSource } from "../src/credentials/secret-source.ts";

const env = {
  GOOGLE_OAUTH_CLIENT_ID: "gid",
  GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
  SLACK_OAUTH_CLIENT_ID: "sid",
  SLACK_OAUTH_CLIENT_SECRET: "ssecret",
  NOTION_OAUTH_CLIENT_ID: "nid",
  NOTION_OAUTH_CLIENT_SECRET: "nsecret",
  GITHUB_OAUTH_CLIENT_ID: "ghid",
  GITHUB_OAUTH_CLIENT_SECRET: "ghsecret",
  X_OAUTH_CLIENT_ID: "xid",
  X_OAUTH_CLIENT_SECRET: "xsecret",
} as NodeJS.ProcessEnv;

const resolve = createSecretClientResolver(createEnvSecretSource(env));
const googleClient = (): Promise<ResolvedClient> => resolve("google", {});

test("authorizeUrl builds a consent URL with client id, scopes, redirect, state", async () => {
  const url = authorizeUrl("google", { redirectUri: "https://app/cb", state: "st-1", client: await googleClient() });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, PROVIDERS.google!.authUrl);
  assert.equal(u.searchParams.get("client_id"), "gid");
  assert.equal(u.searchParams.get("redirect_uri"), "https://app/cb");
  assert.equal(u.searchParams.get("state"), "st-1");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.match(u.searchParams.get("scope") ?? "", /gmail\.modify/);
  assert.match(u.searchParams.get("scope") ?? "", /auth\/drive(\s|$)/);
  assert.match(u.searchParams.get("scope") ?? "", /spreadsheets/);
});

test("createSecretClientResolver refuses when the provider isn't configured (creds = the only gap)", async () => {
  const bare = createSecretClientResolver(createEnvSecretSource({} as NodeJS.ProcessEnv));
  await assert.rejects(bare("google", {}), /GOOGLE_OAUTH_CLIENT_ID/);
});

test("the env resolver pins the Google hosted-domain for the company account-type", async () => {
  const r = createSecretClientResolver(createEnvSecretSource({ ...env, GOOGLE_WORKSPACE_DOMAIN: "example.com" }));
  const url = new URL(
    authorizeUrl("google", {
      redirectUri: "https://app/cb",
      state: "s",
      client: await r("google", { accountType: "company" }),
      accountType: "company",
    }),
  );
  assert.equal(url.searchParams.get("hd"), "example.com");
  const personal = new URL(
    authorizeUrl("google", {
      redirectUri: "https://app/cb",
      state: "s",
      client: await r("google", { accountType: "personal" }),
      accountType: "personal",
    }),
  );
  assert.equal(personal.searchParams.get("hd"), null);
});

test("exchangeCode returns a token for the provider's hosts (default authorization_code adapter)", async () => {
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, PROVIDERS.google!.tokenUrl);
    assert.match(init.body, /grant_type=authorization_code/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a b" }),
    };
  };
  const { hosts, token } = await exchangeCode("google", "code-123", "https://app/cb", {
    client: await googleClient(),
    fetchImpl,
    now: 1_000,
  });
  assert.deepEqual(hosts, PROVIDERS.google!.hosts);
  assert.equal(token.accessToken, "at");
  assert.equal(token.refreshToken, "rt");
  assert.equal(token.expiresAt, 1_000 + 3600_000);
  assert.deepEqual(token.grantedScopes, ["a", "b"]);
});

test("makeRefresh exchanges a refresh token, keeping it if the provider omits a new one", async () => {
  const fetchImpl: FetchLike = async (_url, init) => {
    assert.match(init.body, /grant_type=refresh_token/);
    return { ok: true, status: 200, json: async () => ({ access_token: "at2", expires_in: 3600 }) };
  };
  const refresh = makeRefresh({ resolveClient: resolve, fetchImpl, now: () => 2_000 });
  const fresh = await refresh("gmail.googleapis.com", { accessToken: "old", refreshToken: "rt", expiresAt: 0 });
  assert.equal(fresh.accessToken, "at2");
  assert.equal(fresh.refreshToken, "rt");
  assert.equal(fresh.expiresAt, 2_000 + 3600_000);
});

test("refresh dispatches by host (calendar host → google provider)", async () => {
  let hit = "";
  const fetchImpl: FetchLike = async (url) => {
    hit = url;
    return { ok: true, status: 200, json: async () => ({ access_token: "at" }) };
  };
  const refresh = makeRefresh({ resolveClient: resolve, fetchImpl });
  await refresh("www.googleapis.com", { accessToken: "x", refreshToken: "rt" });
  assert.equal(hit, PROVIDERS.google!.tokenUrl);
});

test("google company-slot exchange verifies the id_token hosted domain server-side", async () => {
  const r = createSecretClientResolver(createEnvSecretSource({ ...env, GOOGLE_WORKSPACE_DOMAIN: "example.com" }));
  const client = await r("google", { accountType: "company" });
  const idToken = (hd?: string) =>
    ["h", Buffer.from(JSON.stringify({ sub: "1", ...(hd ? { hd } : {}) }), "utf8").toString("base64url"), "s"].join(
      ".",
    );
  const respondWith =
    (body: Record<string, unknown>): FetchLike =>
    async () => ({ ok: true, status: 200, json: async () => body });

  const ok = await exchangeCode("google", "c", "https://app/cb", {
    client,
    accountType: "company",
    fetchImpl: respondWith({ access_token: "at", id_token: idToken("example.com") }),
  });
  assert.equal(ok.token.accessToken, "at");

  await assert.rejects(
    () =>
      exchangeCode("google", "c", "https://app/cb", {
        client,
        accountType: "company",
        fetchImpl: respondWith({ access_token: "at", id_token: idToken("evil.example") }),
      }),
    /not in the example\.com workspace/,
  );
  await assert.rejects(
    () =>
      exchangeCode("google", "c", "https://app/cb", {
        client,
        accountType: "company",
        fetchImpl: respondWith({ access_token: "at", id_token: idToken() }),
      }),
    /not in the example\.com workspace/,
  );
  await assert.rejects(
    () =>
      exchangeCode("google", "c", "https://app/cb", {
        client,
        accountType: "company",
        fetchImpl: respondWith({ access_token: "at" }),
      }),
    /not in the example\.com workspace/,
  );

  const personal = await exchangeCode("google", "c", "https://app/cb", {
    client: await r("google", { accountType: "personal" }),
    accountType: "personal",
    fetchImpl: respondWith({ access_token: "at" }),
  });
  assert.equal(personal.token.accessToken, "at");
});

test("github refresh asks for JSON and surfaces GitHub's 200-with-error bodies", async () => {
  const good: FetchLike = async (url, init) => {
    assert.equal(url, PROVIDERS.github!.tokenUrl);
    assert.equal(init.headers.accept, "application/json");
    assert.match(init.body, /grant_type=refresh_token/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "gh-at2", refresh_token: "gh-rt2", expires_in: 28800 }),
    };
  };
  const fresh = await makeRefresh({ resolveClient: resolve, fetchImpl: good, now: () => 1_000 })("api.github.com", {
    accessToken: "old",
    refreshToken: "gh-rt",
    expiresAt: 0,
  });
  assert.equal(fresh.accessToken, "gh-at2");
  assert.equal(fresh.refreshToken, "gh-rt2");
  assert.equal(fresh.expiresAt, 1_000 + 28800_000);

  const errBody: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect" }),
  });
  await assert.rejects(
    () =>
      makeRefresh({ resolveClient: resolve, fetchImpl: errBody })("api.github.com", {
        accessToken: "old",
        refreshToken: "gh-rt",
      }),
    /refresh token passed is incorrect/,
  );
});

test("github exchange asks for JSON and surfaces GitHub's 200-with-error bodies", async () => {
  const errBody: FetchLike = async (url, init) => {
    assert.equal(url, PROVIDERS.github!.tokenUrl);
    assert.equal(init.headers.accept, "application/json");
    assert.match(init.body, /grant_type=authorization_code/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      }),
    };
  };
  const ghClient = await resolve("github", {});
  await assert.rejects(
    () => exchangeCode("github", "c", "https://app/cb", { client: ghClient, fetchImpl: errBody }),
    /code passed is incorrect or expired/,
  );
});

test("makeRefresh never returns an empty access token (parseable junk can't poison the keychain)", async () => {
  const empty: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ token_type: "bearer" }) });
  await assert.rejects(
    () =>
      makeRefresh({ resolveClient: resolve, fetchImpl: empty })("gmail.googleapis.com", {
        accessToken: "old",
        refreshToken: "rt",
      }),
    /empty access token/,
  );
});

test("Slack uses oauth.v2.access and keeps the USER token, scopes in user_scope", async () => {
  const url = new URL(
    authorizeUrl("slack", { redirectUri: "https://app/cb", state: "s", client: await resolve("slack", {}) }),
  );
  assert.equal(url.searchParams.get("user_scope"), PROVIDERS.slack!.scopes.join(" "));
  assert.equal(url.searchParams.get("scope"), null);

  const fetchImpl: FetchLike = async (u) => {
    assert.equal(u, PROVIDERS.slack!.tokenUrl);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        access_token: "bot-tok",
        authed_user: { access_token: "user-tok", scope: "users:read chat:write" },
      }),
    };
  };
  const { hosts, token } = await exchangeCode("slack", "c", "https://app/cb", {
    client: await resolve("slack", {}),
    fetchImpl,
  });
  assert.deepEqual(hosts, ["slack.com"]);
  assert.equal(token.accessToken, "user-tok");
  assert.deepEqual(token.grantedScopes, ["users:read", "chat:write"]);
});

test("Slack consent requests the canvas scopes so fresh connections can edit canvases", async () => {
  const url = new URL(
    authorizeUrl("slack", { redirectUri: "https://app/cb", state: "s", client: await resolve("slack", {}) }),
  );
  const scopes = (url.searchParams.get("user_scope") ?? "").split(" ");
  assert.ok(scopes.includes("canvases:read"), "canvases:read missing from Slack user_scope");
  assert.ok(scopes.includes("canvases:write"), "canvases:write missing from Slack user_scope");
});

test("Slack surfaces a provider-side oauth error", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error: "invalid_code" }),
  });
  const slackClient = await resolve("slack", {});
  await assert.rejects(
    () => exchangeCode("slack", "c", "https://app/cb", { client: slackClient, fetchImpl }),
    /invalid_code/,
  );
});

test("Slack/Notion reject a degenerate ok-but-no-token response (no empty token persisted)", async () => {
  const slackClient = await resolve("slack", {});
  const notionClient = await resolve("notion", {});
  const slackEmpty: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  await assert.rejects(
    () => exchangeCode("slack", "c", "https://app/cb", { client: slackClient, fetchImpl: slackEmpty }),
    /no usable token/,
  );
  const notionEmpty: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ workspace_id: "w" }) });
  await assert.rejects(
    () => exchangeCode("notion", "c", "https://app/cb", { client: notionClient, fetchImpl: notionEmpty }),
    /no access_token/,
  );
});

test("Notion exchanges via HTTP Basic + JSON body and does not refresh", async () => {
  const fetchImpl: FetchLike = async (u, init) => {
    assert.equal(u, PROVIDERS.notion!.tokenUrl);
    assert.match(init.headers.authorization ?? "", /^Basic /);
    assert.match(init.body, /"grant_type":"authorization_code"/);
    return { ok: true, status: 200, json: async () => ({ access_token: "notion-tok" }) };
  };
  const { token } = await exchangeCode("notion", "c", "https://app/cb", {
    client: await resolve("notion", {}),
    fetchImpl,
  });
  assert.equal(token.accessToken, "notion-tok");
  await assert.rejects(
    () => makeRefresh({ resolveClient: resolve })("api.notion.com", { accessToken: "x", refreshToken: "rt" }),
    /do not refresh/,
  );
});

test("scopesFor: BYO client scopes override the provider default", async () => {
  const byo: ResolvedClient = { id: "x", secret: "y", clientRef: "org:default-org:google", scopes: ["only.this"] };
  assert.deepEqual(scopesFor(PROVIDERS.google!, byo), ["only.this"]);
  assert.deepEqual(scopesFor(PROVIDERS.google!, await googleClient()), PROVIDERS.google!.scopes);
});

test("OAuth state is sealed, scoped (org/accountType/clientRef), and expires", async () => {
  const state = await sealOAuthState(
    {
      provider: "google",
      principalId: "U1",
      redirectUri: "https://app/callback",
      returnTo: "/settings",
      accountType: "company",
      clientRef: "env:google",
      issuedAt: 1_000,
      nonce: "n1",
    },
    { secret: "state-secret" },
  );
  assert.deepEqual(await openOAuthState(state, { secret: "state-secret", now: () => 2_000 }), {
    provider: "google",
    principalId: "U1",
    redirectUri: "https://app/callback",
    returnTo: "/settings",
    accountType: "company",
    clientRef: "env:google",
    issuedAt: 1_000,
    nonce: "n1",
  });
  await assert.rejects(() => openOAuthState(`${state}x`, { secret: "state-secret" }), /invalid OAuth state/);
  await assert.rejects(
    () => openOAuthState(state, { secret: "state-secret", now: () => 900_000, maxAgeMs: 10_000 }),
    /expired OAuth state/,
  );
});

test("codeChallengeS256 matches the RFC 7636 test vector", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(codeChallengeS256(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("generateCodeVerifier is URL-safe and high-entropy", () => {
  const v = generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/, "base64url, no padding");
  assert.ok(v.length >= 43, "at least 256 bits of entropy encoded");
  assert.notEqual(v, generateCodeVerifier(), "fresh each call");
});

test("authorizeUrl adds code_challenge + S256 only when a challenge is supplied", async () => {
  const client = await googleClient();
  const withPkce = new URL(
    authorizeUrl("google", { redirectUri: "https://app/cb", state: "s", client, codeChallenge: "CHAL" }),
  );
  assert.equal(withPkce.searchParams.get("code_challenge"), "CHAL");
  assert.equal(withPkce.searchParams.get("code_challenge_method"), "S256");
  const without = new URL(authorizeUrl("google", { redirectUri: "https://app/cb", state: "s", client }));
  assert.equal(without.searchParams.get("code_challenge"), null, "no PKCE params when no challenge passed");
  assert.equal(without.searchParams.get("code_challenge_method"), null);
});

test("only X opts into PKCE; the other providers leave the seam inert (regression guard)", () => {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (name === "x") assert.equal(p.pkce, true, "X requires PKCE");
    else assert.notEqual(p.pkce, true, `${name} must not enable PKCE`);
  }
});

test("exchangeCode sends code_verifier in the token body when provided, omits it otherwise", async () => {
  const client = await googleClient();
  const bodies: string[] = [];
  const capture: FetchLike = async (_url, init) => {
    bodies.push(init.body);
    return { ok: true, status: 200, json: async () => ({ access_token: "at" }) };
  };
  await exchangeCode("google", "code-1", "https://app/cb", {
    client,
    fetchImpl: capture,
    now: 1_000,
    codeVerifier: "the-verifier",
  });
  assert.match(bodies[0]!, /(^|&)code_verifier=the-verifier(&|$)/, "verifier is in the exchange body");
  await exchangeCode("google", "code-2", "https://app/cb", { client, fetchImpl: capture, now: 1_000 });
  assert.doesNotMatch(bodies[1]!, /code_verifier/, "no verifier when none provided");
});

test("OAuth state round-trips the PKCE verifier", async () => {
  const sealed = await sealOAuthState(
    { provider: "x", principalId: "U1", redirectUri: "https://app/cb", codeVerifier: "ver-abc" },
    { secret: "state-secret" },
  );
  const opened = await openOAuthState(sealed, { secret: "state-secret" });
  assert.equal(opened.codeVerifier, "ver-abc");
});

const xClient = (): Promise<ResolvedClient> => resolve("x", {});

test("X authorize URL targets x.com with the tweet scopes and offline.access", async () => {
  const u = new URL(
    authorizeUrl("x", { redirectUri: "https://app/cb", state: "s", client: await xClient(), codeChallenge: "CH" }),
  );
  assert.equal(u.origin + u.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(u.searchParams.get("code_challenge"), "CH");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  const scope = u.searchParams.get("scope") ?? "";
  for (const s of ["tweet.read", "tweet.write", "users.read", "offline.access"])
    assert.match(scope, new RegExp(s.replace(".", "\\.")));
});

test("X exchange uses HTTP Basic client auth, sends the PKCE verifier, keeps secret out of the body", async () => {
  let seen: { url: string; auth?: string; body: string } | null = null;
  const fetchImpl: FetchLike = async (url, init) => {
    seen = { url, auth: init.headers.authorization, body: init.body };
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "xat", refresh_token: "xrt", expires_in: 7200 }),
    };
  };
  const { hosts, token } = await exchangeCode("x", "code-x", "https://app/cb", {
    client: await xClient(),
    fetchImpl,
    now: 1_000,
    codeVerifier: "verif",
  });
  assert.equal(seen!.url, "https://api.x.com/2/oauth2/token");
  assert.equal(
    seen!.auth,
    `Basic ${Buffer.from("xid:xsecret").toString("base64")}`,
    "client creds ride the Basic header",
  );
  assert.match(seen!.body, /grant_type=authorization_code/);
  assert.match(seen!.body, /code_verifier=verif/, "PKCE verifier is sent");
  assert.doesNotMatch(seen!.body, /client_secret/, "secret is never in the body under Basic auth");
  assert.deepEqual(hosts, ["api.x.com"]);
  assert.equal(token.accessToken, "xat");
  assert.equal(token.refreshToken, "xrt");
  assert.equal(token.expiresAt, 1_000 + 7200_000);
});

test("X refresh captures the ROTATED refresh token (single-use) — the connection survives past 2h", async () => {
  const fetchImpl: FetchLike = async (_url, init) => {
    assert.match(init.body, /grant_type=refresh_token/);
    assert.match(init.body, /refresh_token=old-rt/);
    assert.doesNotMatch(init.body, /client_secret/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "xat2", refresh_token: "new-rt", expires_in: 7200 }),
    };
  };
  const fresh = await makeRefresh({ resolveClient: resolve, fetchImpl, now: () => 5_000 })("api.x.com", {
    accessToken: "old",
    refreshToken: "old-rt",
    expiresAt: 0,
  });
  assert.equal(fresh.accessToken, "xat2");
  assert.equal(fresh.refreshToken, "new-rt", "the rotated refresh token replaces the old one");
  assert.equal(fresh.expiresAt, 5_000 + 7200_000);
});
