import { isObj } from "../util/objects.ts";

export class GmailApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number;
  readonly detail: string;

  constructor(path: string, status: number, retryAfterSeconds: number, detail: string) {
    super(`Gmail ${path.split("?")[0]} returned ${status}`);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
  }
}

export function gmailApi(token: string, fetchImpl: typeof fetch = fetch) {
  return async <T>(path: string, { body, timeoutMs = 20_000 }: { body?: unknown; timeoutMs?: number } = {}) => {
    const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new GmailApiError(
        path,
        response.status,
        Number(response.headers.get("retry-after")),
        (await response.text().catch(() => "")).slice(0, 300),
      );
    return (await response.json()) as T;
  };
}

export function gmailPartText(part: Record<string, unknown>, mimeType = "text/plain"): string | undefined {
  const texts: string[] = [];
  const visit = (node: Record<string, unknown>): void => {
    if (node.filename) return;
    const data = isObj(node.body) ? node.body.data : undefined;
    if (node.mimeType === mimeType && typeof data === "string")
      texts.push(Buffer.from(data, "base64url").toString("utf8"));
    for (const nested of Array.isArray(node.parts) ? node.parts.filter(isObj) : []) visit(nested);
  };
  visit(part);
  return texts.length ? texts.join("\n") : undefined;
}

export function gmailHeader(payload: Record<string, unknown>, name: string): string {
  const headers = Array.isArray(payload.headers) ? payload.headers.filter(isObj) : [];
  const found = headers.find((h) => typeof h.name === "string" && h.name.toLowerCase() === name.toLowerCase());
  return typeof found?.value === "string" ? found.value : "";
}

const HIDDEN_LABELS = new Set<unknown>(["DRAFT", "TRASH", "SPAM"]);

export function gmailThreadMessages(thread: { messages?: unknown[] }): Record<string, unknown>[] {
  return (Array.isArray(thread.messages) ? thread.messages.filter(isObj) : [])
    .filter((m) => !(Array.isArray(m.labelIds) && m.labelIds.some((label) => HIDDEN_LABELS.has(label))))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
}
