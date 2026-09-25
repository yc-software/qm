import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";

export interface RememberedSession {
  email: string;
  authTime: number;
  expiresAtMs: number;
}

export interface RememberedSessions {
  create(email: string, idleS: number, absoluteS: number): Promise<RememberedSession & { token: string }>;
  use(token: string): Promise<RememberedSession | null>;
}

export function coreRememberedSessions(baseUrl: string, secret: string | undefined): RememberedSessions {
  async function post(pathname: string, data: unknown): Promise<unknown> {
    const path = withSourceAuthNonce(`/v1/auth/broker/sessions${pathname}`, secret);
    const body = JSON.stringify(data);
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: signedHeaders(secret, "POST", path, body),
      body,
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`broker sessions unavailable: HTTP ${response.status}`);
    return response.json();
  }
  return {
    async create(email, idleS, absoluteS) {
      return (await post("", { email, idleS, absoluteS })) as RememberedSession & { token: string };
    },
    async use(token) {
      return ((await post("/use", { token })) as { session: RememberedSession | null }).session;
    },
  };
}
