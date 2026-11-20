import type { BrowserSessionStore } from "./browser-session-store.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { SLACK_AUTH_ERRORS } from "../slack/payloads.ts";

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

const SIGN_IN_AGAIN =
  "To fix it, have the person you're helping sign in to Slack in a live browser (the browse skill), then save that browser's Slack cookies with PUT /v1/emoji/session and retry. Their own session is used for their uploads from then on.";

const EMOJI_UPLOAD_NO_SESSION = `There's no saved Slack session for you, and no fallback account has one either. ${SIGN_IN_AGAIN}`;

export const EMOJI_UPLOAD_SESSION_EXPIRED = `The Slack session the emoji uploader uses has expired. ${SIGN_IN_AGAIN}`;

const PERMISSION_ERRORS = new Set(["no_permission", "missing_scope", "restricted_action", "user_is_restricted"]);
const TOO_BIG_ERRORS = new Set(["resized_but_still_too_large", "error_too_big", "too_large"]);

function humanizeEmojiError(err: string | undefined): string {
  if (!err) return "the emoji upload failed.";
  if (SLACK_AUTH_ERRORS.has(err)) return EMOJI_UPLOAD_SESSION_EXPIRED;
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

type SlackCookie = { name: string; value: string; domain?: string };

function slackCookies(storageStateJson: string): SlackCookie[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storageStateJson);
  } catch {
    return null;
  }
  const cookies = (parsed as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) return null;
  const slack = cookies.filter(
    (c): c is SlackCookie =>
      !!c &&
      typeof c.name === "string" &&
      typeof c.value === "string" &&
      (c.domain === "slack.com" || String(c.domain ?? "").endsWith(".slack.com")),
  );
  return slack.some((c) => c.name === "d") ? slack : null;
}

export function slackCookieHeader(storageStateJson: string): string | null {
  const slack = slackCookies(storageStateJson);
  return slack ? slack.map((c) => `${c.name}=${c.value}`).join("; ") : null;
}

async function mintApiToken(
  workspace: string,
  cookie: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ token: string | null; status: number }> {
  const r = await fetchImpl(`https://${workspace}/`, {
    headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await r.text();
  const key = '"api_token":"';
  const start = html.indexOf(`${key}xoxc-`);
  const end = start < 0 ? -1 : html.indexOf('"', start + key.length);
  return { token: end < 0 ? null : html.slice(start + key.length, end), status: r.status };
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

  let minted: { token: string | null; status: number };
  try {
    minted = await mintApiToken(workspace, cookie, fetchImpl, timeoutMs);
  } catch (e) {
    return { ok: false, error: `couldn't reach ${workspace} to start the upload: ${errMessage(e)}` };
  }
  const token = minted.token;
  if (!token) {
    return {
      ok: false,
      error: `${EMOJI_UPLOAD_SESSION_EXPIRED} (${workspace} answered HTTP ${minted.status} without a session token.)`,
    };
  }

  let resp: { ok?: boolean; error?: string };
  try {
    resp = await callEmojiAdd(workspace, cookie, token, req.name, image, imageExt(image), fetchImpl, timeoutMs);
  } catch (e) {
    return { ok: false, error: `the emoji upload request failed: ${errMessage(e)}` };
  }
  if (resp.ok || resp.error === "error_name_taken") return { ok: true, name: req.name, workspace };
  return { ok: false, error: humanizeEmojiError(resp.error) };
}

export type SlackSessionSaveResult = { ok: true; workspace: string } | { ok: false; error: string };

export async function saveSlackSession(
  deps: EmojiUploadDeps & { sessionStore: BrowserSessionStore },
  req: { storageStateJson: string; workspace?: string },
): Promise<SlackSessionSaveResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const workspace = normalizeWorkspace(req.workspace) || normalizeWorkspace(deps.connectorWorkspace);
  if (!workspace) return { ok: false, error: EMOJI_UPLOAD_NO_WORKSPACE };
  const cookies = slackCookies(req.storageStateJson);
  if (!cookies) {
    return {
      ok: false,
      error:
        "No Slack sign-in cookie (`d` on .slack.com) in those cookies — the browser isn't signed in to Slack yet. Have the person finish signing in on the live view, then export again.",
    };
  }
  const state = JSON.stringify({ cookies });
  let minted: { token: string | null; status: number };
  try {
    minted = await mintApiToken(workspace, slackCookieHeader(state)!, fetchImpl, timeoutMs);
  } catch (e) {
    return { ok: false, error: `couldn't reach ${workspace} to check the session: ${errMessage(e)}` };
  }
  if (!minted.token) {
    return {
      ok: false,
      error: `Those cookies aren't signed in to ${workspace} (it answered HTTP ${minted.status} without a session token) — nothing was saved. Make sure the person signed in to that workspace (not another one) on the live view, then export again.`,
    };
  }
  await deps.sessionStore.put(deps.principalId, state);
  return { ok: true, workspace };
}
