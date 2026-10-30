import { readFileSync } from "node:fs";
import { fetchCoreText } from "../../chassis/src/core-client.ts";
import { CORE_API_URL, CORE_SIGNING_SECRET } from "../../chassis/src/env.ts";
const [host, principalId] = process.argv.slice(2);
const accessToken = readFileSync(0, "utf8").trim();
if (!host || !principalId || !accessToken) {
  console.error("usage: settok.ts <host> <principalId> < token");
  process.exit(2);
}
const r = await fetchCoreText({
  origin: CORE_API_URL,
  secret: CORE_SIGNING_SECRET,
  method: "POST",
  path: "/v1/connectors/token",
  body: JSON.stringify({ host, principalId, accessToken }),
});
const line = `${new Date().toISOString()} ${host} status ${r.status}`;
if (r.status !== 200) {
  console.error(line, r.text);
  process.exit(1);
}
console.log(line, r.text);
