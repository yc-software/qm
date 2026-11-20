export class GoogleApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number;
  readonly detail: string;

  constructor(path: string, status: number, retryAfterSeconds: number, detail: string) {
    super(`Google ${path.split("?")[0]} returned ${status}`);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.detail = detail;
  }
}

export function googleApi(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  return async <T>(
    path: string,
    { method, body, timeoutMs = 20_000 }: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new GoogleApiError(
        path,
        response.status,
        Number(response.headers.get("retry-after")),
        (await response.text().catch(() => "")).slice(0, 300),
      );
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}

export function gmailApi(token: string, fetchImpl: typeof fetch = fetch) {
  return googleApi("https://gmail.googleapis.com/gmail/v1/users/me/", token, fetchImpl);
}
