export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      message = parsed.error ?? body;
    } catch {}
    throw new HttpError(message || response.statusText, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}
