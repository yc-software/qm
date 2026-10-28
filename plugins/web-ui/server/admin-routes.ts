import { reportBackendError } from "../../chassis/src/error-reporting.ts";
import { type HttpMethod } from "../../chassis/src/core-client.ts";
import { json } from "../../chassis/src/http.ts";

import { coreOrgId } from "../../chassis/src/env.ts";

import {
  type WebCtx,
  brandingCache,
  coreFetch,
  enc,
  fetchCoreGet,
  pipeUpstream,
  readBody,
  relay,
  relayCore,
  portalHeaders,
} from "./core-relay.ts";
import { stagedFile } from "./uploads.ts";

const ADMIN_WRITES: Record<string, string> = {
  grants: "POST DELETE",
  "principal-links": "POST DELETE",
  "external-users": "POST DELETE",
  memory: "POST PATCH DELETE",
  crons: "PUT",
  skills: "DELETE",
  "skill-packs": "POST PATCH DELETE",
  users: "PUT POST",
  "slack-installation": "POST PUT DELETE",
  "model-providers": "PUT DELETE",
  "custom-providers": "PUT DELETE",
  "mcp-servers": "PUT DELETE",
};

const ADMIN_READS = new Set(
  [
    "whoami scopes resources spend egress errors audit crons deployments skills skill-packs sessions runs files",
    "retention users directory keychain memory ambient-context ambient-judgments ack-emoji-picks slack-installation",
    "slack-emoji model-providers custom-providers mcp-servers principal-links",
  ]
    .join(" ")
    .split(" "),
);

export async function adminRoute(c: WebCtx): Promise<unknown> {
  const { req, res, url } = c;
  const method = req.method ?? "GET";
  const rest = url.pathname.slice("/api/admin/".length);
  const first = rest.split("/")[0] ?? "";
  const corePath = `/v1/admin/${rest}${url.search}`;
  const headers = { "x-admin-actor": `${c.user}@${coreOrgId()}`, ...portalHeaders() };
  const relayAdmin = async (to: HttpMethod, path = corePath, withBody = to !== "GET" && to !== "DELETE") =>
    relayCore(res, to, path, withBody ? await readBody(req) : "", headers);
  if (method === "GET" && rest === "connector-catalog") return relayAdmin("GET", "/v1/connectors/catalog");
  if (
    method === "GET" &&
    (rest === "files/download" || (rest === "spend" && url.searchParams.get("format") === "csv"))
  ) {
    const upstream = await fetchCoreGet(corePath, { redirect: "manual" }, headers);
    return pipeUpstream(res, upstream, [
      "content-type",
      "content-length",
      "content-disposition",
      "x-content-type-options",
      "content-security-policy",
      "cache-control",
    ]);
  }
  if (method === "POST" && rest === "files/upload") {
    const scope = url.searchParams.get("scope") ?? "";
    if (!scope) {
      req.resume();
      return json(res, 400, { error: "bad_request", message: "scope required" });
    }
    const file = await stagedFile(c);
    if (!file) return;
    return relayCore(res, "POST", `/v1/admin/files/upload?scope=${enc(scope)}`, JSON.stringify(file), headers);
  }
  if (first === "scopes" && rest.length > "scopes/".length) {
    if (method === "GET") return relayAdmin("GET");
    if (method === "PUT" && rest.lastIndexOf("/") > "scopes/".length) {
      if (!rest.endsWith("/branding")) return relayAdmin("PUT");
      const saved = await coreFetch("PUT", corePath, await readBody(req), undefined, headers);
      if (saved.status < 300)
        await brandingCache()
          .refreshNow()
          .catch((err: unknown) => reportBackendError(err));
      return relay(res, saved);
    }
  }
  if (ADMIN_WRITES[first]?.split(" ").includes(method)) return relayAdmin(method as HttpMethod);
  if (method === "GET" && ADMIN_READS.has(first)) return relayAdmin("GET");
  req.resume();
  return json(res, 404, { error: "not_found" });
}
