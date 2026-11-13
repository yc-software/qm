import { trimTrailingSlashes } from "../../util/text.ts";
import { ACCOUNT_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signGenericChatRequest } from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 15_000;
export const GENERIC_CHAT_CLAIM_MS = 4 * REQUEST_TIMEOUT_MS;

export class GenericChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) {
    super(`generic-chat ${status}: ${reason}`);
    this.status = status;
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type GenericChatClient = ReturnType<typeof createGenericChatClient>;

export function createGenericChatClient(deps: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const base = trimTrailingSlashes(deps.url);
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  async function call(
    account: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
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

  return { call };
}
