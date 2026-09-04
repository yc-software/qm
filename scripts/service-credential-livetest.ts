import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { mintCapabilityToken, CREDENTIAL_BROKER_AUD, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { swallowAs } from "../src/util/errors.ts";

const SECRET = process.env.CORE_SIGNING_SECRET;
if (!SECRET) {
  console.error("CORE_SIGNING_SECRET is required (read it from the dev instance's .env).");
  process.exit(1);
}
const BASE = (process.argv[2] || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, "");
const ORG = "acme";
const ADMIN_ACTOR = process.env.ADMIN_ACTOR || "admin-alice@acme";
const SLUG = `dev-echo-${process.pid}`;
const TARGET_URL = process.env.BROKER_TARGET_URL || "https://postman-echo.com/get?hello=world";
const TARGET_HOST = new URL(TARGET_URL).hostname;
const FAKE_SECRET = "dev-bearer-DO-NOT-USE-12345";

let passes = 0;
let fails = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok) passes++;
  else fails++;
}

let nonce = 0;

async function admin(
  method: string,
  pathWithQuery: string,
  bodyObj?: unknown,
): Promise<{ status: number; json: any; raw: string }> {
  const p = `${pathWithQuery}${pathWithQuery.includes("?") ? "&" : "?"}_n=${++nonce}`;
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const headers = signedRequestHeaders(SECRET, method, p, body, {
    "content-type": "application/json",
    "x-admin-actor": ADMIN_ACTOR,
  });
  const res = await fetch(BASE + p, { method, headers, ...(body ? { body } : {}) });
  const raw = await res.text();
  return { status: res.status, json: raw ? JSON.parse(raw) : null, raw };
}

async function broker(credentials: string[], reqBody: unknown): Promise<{ status: number; json: any }> {
  const token = await mintCapabilityToken(
    {
      actorId: "U-dev",
      scopeId: "personal:U-dev",
      aud: CREDENTIAL_BROKER_AUD,
      credentials,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET!,
  );
  const res = await fetch(`${BASE}/v1/credentials/broker`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-capability": token },
    body: JSON.stringify(reqBody),
  });
  return { status: res.status, json: await res.json().catch(swallowAs("livetest: broker response json parse", null)) };
}

async function main(): Promise<void> {
  console.log(`→ core: ${BASE}   org: ${ORG}   echo target: ${TARGET_URL}\n`);

  const vend = await admin("PUT", `/v1/admin/scopes/org:${ORG}/service-credentials`, {
    slug: SLUG,
    name: "Dev echo",
    secret: FAKE_SECRET,
    host: TARGET_HOST,
    allowedMethods: ["GET"],
    allowedPathPrefixes: ["/get"],
  });
  check("admin vends a credential (PUT → 200)", vend.status === 200, `status ${vend.status} ${vend.raw.slice(0, 120)}`);

  const cfg1 = await admin("GET", `/v1/admin/scopes/org:${ORG}`);
  const cred = cfg1.json?.serviceCredentials?.find((c: any) => c.slug === SLUG);
  check(
    "GET projects the credential (hasSecret, no material)",
    !!cred && cred.hasSecret === true && !cfg1.raw.includes(FAKE_SECRET),
    cred ? `grantees=${JSON.stringify(cred.grantees)} usage=${cred.usageCount}` : "not found",
  );
  check("default sharing is org-wide", !!cred && Array.isArray(cred.grantees) && cred.grantees.includes(`org:${ORG}`));

  const ok = await broker([SLUG], { credential: SLUG, method: "GET", url: TARGET_URL });
  const echoed = JSON.stringify(ok.json?.body ?? "");
  check(
    "broker proxies the call (→ 200, upstream 200)",
    ok.status === 200 && ok.json?.status === 200,
    `broker ${ok.status}, upstream ${ok.json?.status}`,
  );
  check(
    "the bearer was injected on the OUTBOUND call (echoed by the target)",
    echoed.includes(FAKE_SECRET),
    echoed.includes(FAKE_SECRET)
      ? "Authorization: Bearer <secret> seen upstream"
      : "(target may not echo headers; check BROKER_TARGET_URL)",
  );

  const evil = await broker([SLUG], { credential: SLUG, method: "GET", url: "https://example.com/get" });
  check(
    "host-pin blocks a different host (→ 403 host_not_allowed)",
    evil.status === 403 && evil.json?.error === "host_not_allowed",
    `${evil.status} ${evil.json?.error}`,
  );

  const badPath = await broker([SLUG], { credential: SLUG, method: "GET", url: `https://${TARGET_HOST}/post` });
  check(
    "path allowlist blocks an out-of-list path (→ 403 path_not_allowed)",
    badPath.status === 403 && badPath.json?.error === "path_not_allowed",
    `${badPath.status} ${badPath.json?.error}`,
  );

  const badMethod = await broker([SLUG], { credential: SLUG, method: "POST", url: TARGET_URL });
  check(
    "method allowlist blocks POST (→ 403 method_not_allowed)",
    badMethod.status === 403 && badMethod.json?.error === "method_not_allowed",
    `${badMethod.status} ${badMethod.json?.error}`,
  );

  const notEntitled = await broker([], { credential: SLUG, method: "GET", url: TARGET_URL });
  check(
    "a token without the slug is refused (→ 403 not_entitled)",
    notEntitled.status === 403 && notEntitled.json?.error === "not_entitled",
    `${notEntitled.status} ${notEntitled.json?.error}`,
  );

  const cfg2 = await admin("GET", `/v1/admin/scopes/org:${ORG}`);
  const used = cfg2.json?.serviceCredentials?.find((c: any) => c.slug === SLUG)?.usageCount;
  check("usage count incremented by the one successful call", used === 1, `usageCount=${used}`);

  await admin("PUT", `/v1/admin/scopes/org:${ORG}/service-credentials`, {
    slug: SLUG,
    name: "Dev echo",
    host: TARGET_HOST,
    grantees: ["personal:U-dev", "personal:U-other"],
  });
  const cfg3 = await admin("GET", `/v1/admin/scopes/org:${ORG}`);
  const g = cfg3.json?.serviceCredentials?.find((c: any) => c.slug === SLUG)?.grantees ?? [];
  check(
    "re-sharing reconciles the allow-list to the named people",
    g.length === 2 && g.includes("personal:U-dev") && !g.includes(`org:${ORG}`),
    JSON.stringify(g),
  );

  const del = await admin("PUT", `/v1/admin/scopes/org:${ORG}/service-credentials`, { slug: SLUG, delete: true });
  const cfg4 = await admin("GET", `/v1/admin/scopes/org:${ORG}`);
  const gone = !cfg4.json?.serviceCredentials?.some((c: any) => c.slug === SLUG);
  check("delete removes the credential", del.status === 200 && gone);

  console.log(`\n${fails === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("livetest error:", e);
  process.exit(1);
});
