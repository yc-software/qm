import type { TenantKey } from "../../tenants/lookup.ts";
import { trimTrailingSlashes } from "../../util/text.ts";
import {
  ACCOUNT_HEADER,
  PARTNER_CHAT,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signGenericChatRequest,
  type GenericChatAction,
} from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 15_000;
export const GENERIC_CHAT_CLAIM_MS = 4 * REQUEST_TIMEOUT_MS;

export class GenericChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) {
    super(`generic-chat ${status}: ${reason}`);
    this.status = status;
  }
}

interface GenericChatPost {
  client_message_id: string | undefined;
  chat_id: string;
  thread_id?: string;
  body: string;
  file_ids?: readonly string[];
  actions?: readonly GenericChatAction[];
  recipient_user_id?: string;
}

interface GenericChatUpdate {
  chat_id: string;
  message_id: string;
  body: string;
  actions?: readonly GenericChatAction[];
}

interface GenericChatReaction {
  chat_id: string;
  message_id: string;
  name: string;
  skin_tone?: number;
}

interface GenericChatUploadRequest {
  chat_id: string;
  name: string;
  content_type: string;
  size_bytes: number;
}

type Reply = Promise<Record<string, unknown>>;

export interface GenericChatClient {
  readonly surface: string;
  readonly tenantKey: TenantKey;
  readonly reactions?: readonly string[];
  readonly files?: false;
  post(account: string, message: GenericChatPost): Reply;
  update(account: string, message: GenericChatUpdate): Reply;
  delete(account: string, message: { chat_id: string; message_id: string }): Reply;
  typing(account: string, state: { chat_id: string; thread_id?: string; typing: boolean }): Reply;
  react(account: string, reaction: GenericChatReaction, change: { on: boolean; emoji: string }): Reply;
  fileUrl(account: string, file: { file_id: string }): Reply;
  upload(account: string, file: GenericChatUploadRequest): Reply;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createGenericChatClient(deps: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
}): GenericChatClient {
  const base = trimTrailingSlashes(deps.url);
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function call(account: string, path: string, payload: object): Reply {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now() / 1000));
    const res = await send(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [ACCOUNT_HEADER]: account,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signGenericChatRequest(deps.secret, timestamp, account, path, body),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const reply = await res.text();
    const parsed = parseJson(reply);
    if (!res.ok)
      throw new GenericChatHttpError(
        res.status,
        typeof parsed.error === "string" ? parsed.error : reply.slice(0, 200) || res.statusText,
      );
    return parsed;
  }

  return {
    surface: PARTNER_CHAT,
    tenantKey: "partner_chat",
    post: (account, message) => call(account, "/agent_app/messages", message),
    update: (account, message) => call(account, "/agent_app/messages/update", message),
    delete: (account, message) => call(account, "/agent_app/messages/delete", message),
    typing: (account, state) => call(account, "/agent_app/typing", state),
    react: (account, reaction, { on }) =>
      call(account, on ? "/agent_app/reactions/add" : "/agent_app/reactions/remove", reaction),
    fileUrl: (account, file) => call(account, "/agent_app/files/url", file),
    upload: (account, file) => call(account, "/agent_app/files/upload", file),
  };
}
