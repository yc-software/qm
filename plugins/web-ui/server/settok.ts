import { readFileSync } from "node:fs";
import { fetchCoreText } from "../../chassis/src/core-client.ts";
import { CORE_API_URL, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";

// Test-instance only: load one of a user's prod connector tokens into this instance's
// connector store. Usage: node settok.ts <host> [accountType] [principalId] < token
// Reads the raw access token from stdin, POSTs it to the core API, and exits nonzero
// unless the core answers HTTP 200 — so callers (e.g. push-gmail.sh) can detect failure.
const [host, accountType, principalArg] = process.argv.slice(2);
const principalId = principalArg || "josh@ycombinator.com";
const accessToken = readFileSync(0, "utf8").trim();
if (!host || !accessToken) {
  console.error("usage: settok.ts <host> [accountType] [principalId] < token");
  process.exit(2);
}
const r = await fetchCoreText({
  origin: CORE_API_URL,
  secret: CORE_SIGNING_SECRET,
  method: "POST",
  path: "/v1/connectors/token",
  body: JSON.stringify({ host, principalId, accessToken, ...(accountType ? { accountType } : {}) }),
});
console.log(new Date().toISOString(), host, accountType ?? "default", "status", r.status, r.text.slice(0, 120));
if (r.status !== 200) process.exit(1);
