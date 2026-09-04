import type { BrowserSessionStore } from "./browser-session-store.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

const EMOJI_NAME_RE = /^[a-z0-9_'+-]{1,100}$/;

export function isValidEmojiName(name: string): boolean {
  return EMOJI_NAME_RE.test(name);
}

export function normalizeWorkspace(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    (host !== "slack.com" && !host.endsWith(".slack.com"))
  )
    return null;
  return host;
}

export interface EmojiUploadDeps {
  principalId: string;
  sessionStore?: BrowserSessionStore;
  connectorWorkspace?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface EmojiUploadRequest {
  name: string;
  imageBase64: string;
  workspace?: string;
}

export type EmojiUploadResult = { ok: true; name: string; workspace: string } | { ok: false; error: string };

const EMOJI_UPLOAD_NO_WORKSPACE =
  "Can't tell which Slack workspace to target — there's no connected Slack workspace. Pass `workspace` (e.g. acme.slack.com).";

const EMOJI_UPLOAD_NO_SESSION =
  "No Slack session for you, and no fallback account is configured/seeded. Sign in to Slack in the browser first (or have an operator set SLACK_EMOJI_FALLBACK_PRINCIPAL to a seeded account).";

export const EMOJI_UPLOAD_SESSION_EXPIRED =
  "The Slack session for the emoji uploader has expired — an operator needs to sign in to Slack again to refresh it.";

const AUTH_ERRORS = new Set(["not_authed", "invalid_auth", "token_expired", "token_revoked", "account_inactive"]);
const PERMISSION_ERRORS = new Set(["no_permission", "missing_scope", "restricted_action", "user_is_restricted"]);
const TOO_BIG_ERRORS = new Set(["resized_but_still_too_large", "error_too_big", "too_large"]);

function humanizeEmojiError(err: string | undefined): string {
  if (!err) return "the emoji upload failed.";
  if (AUTH_ERRORS.has(err)) return EMOJI_UPLOAD_SESSION_EXPIRED;
  if (PERMISSION_ERRORS.has(err)) return "the uploader account isn't allowed to add custom emoji in this workspace.";
  if (TOO_BIG_ERRORS.has(err))
    return "the image is too large — use a smaller square PNG or GIF (Slack's limit is 128×128 and 128KB).";
  if (err === "error_bad_name_i18n") return `this isn't a valid emoji name for this workspace.`;
  if (err === "ratelimited") return "Slack is rate-limiting emoji uploads right now — try again in a moment.";
  return `the emoji upload failed: ${err}`;
}

async function chooseEmojiPrincipal(deps: EmojiUploadDeps): Promise<string | null> {
  const store = deps.sessionStore;
  if (!store) return deps.principalId;
  const hasSession = async (p: string): Promise<boolean> =>
    !!(await store.get(p).catch(swallowAs("emoji session probe", null)));
  if (await hasSession(deps.principalId)) return deps.principalId;
  const fallback = globalThis.process.env.SLACK_EMOJI_FALLBACK_PRINCIPAL || undefined;
  if (fallback && (await hasSession(fallback))) return fallback;
  return null;
}

function decodeImage(b64: string): Buffer | null {
  if (typeof b64 !== "string" || !b64.trim()) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return null;
  return buf;
}

function imageExt(buf: Buffer): "gif" | "png" {
  return buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8" ? "gif" : "png";
}

export function slackCookieHeader(storageStateJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storageStateJson);
  } catch {
    return null;
  }
  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return null;
  const slack = cookies.filter(
    (c): c is { name: string; value: string; domain?: string } =>
      !!c &&
      typeof c.name === "string" &&
      typeof c.value === "string" &&
      /(^|\.)slack\.com$/.test(String(c.domain ?? "")),
  );
  if (!slack.some((c) => c.name === "d")) return null;
  return slack.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function mintApiToken(
  workspace: string,
  cookie: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const r = await fetchImpl(`https://${workspace}/`, {
    headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/"api_token":"(xoxc-[A-Za-z0-9-]+)"/);
  return m ? m[1]! : null;
}

async function callEmojiAdd(
  workspace: string,
  cookie: string,
  token: string,
  name: string,
  image: Buffer,
  ext: "gif" | "png",
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok?: boolean; error?: string }> {
  const form = new FormData();
  form.append("mode", "data");
  form.append("name", name);
  form.append("token", token);
  form.append("image", new Blob([image], { type: ext === "gif" ? "image/gif" : "image/png" }), `${name}.${ext}`);
  const r = await fetchImpl(`https://${workspace}/api/emoji.add`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await r.json().catch(() => ({ ok: false, error: `non-JSON response (HTTP ${r.status})` }))) as {
    ok?: boolean;
    error?: string;
  };
}

export async function runEmojiUpload(deps: EmojiUploadDeps, req: EmojiUploadRequest): Promise<EmojiUploadResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  if (!isValidEmojiName(req.name)) {
    return {
      ok: false,
      error: `"${req.name}" isn't a valid emoji name — use lowercase letters, digits, _ - + ' (no spaces).`,
    };
  }
  const image = decodeImage(req.imageBase64);
  if (!image) return { ok: false, error: "image must be a non-empty base64-encoded PNG or GIF." };
  const workspace = normalizeWorkspace(req.workspace) || normalizeWorkspace(deps.connectorWorkspace);
  if (!workspace) return { ok: false, error: EMOJI_UPLOAD_NO_WORKSPACE };
  const principal = await chooseEmojiPrincipal(deps);
  if (!principal) return { ok: false, error: EMOJI_UPLOAD_NO_SESSION };

  const state = deps.sessionStore
    ? await deps.sessionStore.get(principal).catch(swallowAs("emoji session get", null))
    : null;
  const cookie = state ? slackCookieHeader(state) : null;
  if (!cookie) return { ok: false, error: EMOJI_UPLOAD_SESSION_EXPIRED };

  let token: string | null;
  try {
    token = await mintApiToken(workspace, cookie, fetchImpl, timeoutMs);
  } catch (e) {
    return { ok: false, error: `couldn't reach ${workspace} to start the upload: ${errMessage(e)}` };
  }
  if (!token) return { ok: false, error: EMOJI_UPLOAD_SESSION_EXPIRED };

  let resp: { ok?: boolean; error?: string };
  try {
    resp = await callEmojiAdd(workspace, cookie, token, req.name, image, imageExt(image), fetchImpl, timeoutMs);
  } catch (e) {
    return { ok: false, error: `the emoji upload request failed: ${errMessage(e)}` };
  }
  if (resp.ok || resp.error === "error_name_taken") return { ok: true, name: req.name, workspace };
  return { ok: false, error: humanizeEmojiError(resp.error) };
}
