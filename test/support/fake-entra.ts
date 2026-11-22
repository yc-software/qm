import type { INetworkModule, NetworkResponse } from "@azure/msal-node";

const reply = <T>(status: number, body: unknown): Promise<NetworkResponse<T>> =>
  Promise.resolve({ status, headers: {}, body: body as T });

export function fakeEntra(answer: (secret: string) => { token: string } | { error: string }) {
  const secrets: string[] = [];
  const network: INetworkModule = {
    sendGetRequestAsync: (url) => {
      const tenant = new URL(url).pathname.split("/")[1];
      return reply(200, {
        tenant_discovery_endpoint: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
        metadata: [],
        issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
        authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        end_session_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/logout`,
        jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      });
    },
    sendPostRequestAsync: (_url, options) => {
      const secret = new URLSearchParams(options?.body).get("client_secret") ?? "";
      secrets.push(secret);
      const answered = answer(secret);
      return "token" in answered
        ? reply(200, { token_type: "Bearer", access_token: answered.token, expires_in: 3600 })
        : reply(401, { error: "invalid_client", error_description: answered.error });
    },
  };
  return { network, secrets };
}
