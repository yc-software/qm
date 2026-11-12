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
