import { z } from "zod";
import { isIP } from "node:net";
import { PROVIDERS, type OAuthProviderConfig } from "./oauth.ts";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      !isIP(url.hostname) &&
      url.hostname.includes(".")
    );
  }, "must be an HTTPS URL without credentials, query, fragment, or IP address");
const host = z
  .string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/)
  .refine((value) => !isIP(value));
const env = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const reservedParams = new Set([
  "client_id",
  "client_secret",
  "redirect_uri",
  "response_type",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
]);
const schema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  label: z.string().trim().min(1).max(100),
  description: z.string().max(300).optional(),
  hosts: z.array(host).min(1).max(20),
  authUrl: httpsUrl,
  tokenUrl: httpsUrl,
  scopes: z.array(z.string().min(1).max(300)).max(100),
  clientIdEnv: env,
  clientSecretEnv: env,
  clientAuth: z.enum(["body", "basic"]).optional(),
  pkce: z.boolean().optional(),
  authParams: z
    .record(z.string(), z.string())
    .refine((params) => Object.keys(params).every((key) => !reservedParams.has(key)))
    .optional(),
});

export type CustomOAuthConnector = z.infer<typeof schema>;
export type OAuthProviderSource = () => Record<string, OAuthProviderConfig>;

export function parseOAuthConnector(text: string): CustomOAuthConnector {
  return schema.parse(JSON.parse(text));
}

export function oauthProvidersFor(
  connectors: readonly CustomOAuthConnector[] = [],
): Record<string, OAuthProviderConfig> {
  const providers: Record<string, OAuthProviderConfig> = Object.assign(Object.create(null), PROVIDERS);
  for (const connector of connectors) {
    if (Object.hasOwn(providers, connector.id) || ["constructor", "prototype", "__proto__"].includes(connector.id))
      throw new Error(`duplicate or reserved OAuth provider: ${connector.id}`);
    for (const h of connector.hosts) {
      if (
        ["auth.openai.com", "claude.ai"].some(
          (reserved) => h === reserved || h.endsWith(`.${reserved}`) || reserved.endsWith(`.${h}`),
        )
      )
        throw new Error(`reserved OAuth host: ${h}`);
      if (
        Object.values(providers).some((p) =>
          p.hosts.some((other) => h === other || h.endsWith(`.${other}`) || other.endsWith(`.${h}`)),
        )
      )
        throw new Error(`overlapping OAuth host: ${h}`);
    }
    providers[connector.id] = {
      ...connector,
      redirectPath: `${connector.id}/callback`,
      consentMode: "standard",
      egressRule: [
        ...new Set([...connector.hosts, new URL(connector.authUrl).hostname, new URL(connector.tokenUrl).hostname]),
      ],
      setupGuide: {
        console: `${connector.label} authorization endpoint`,
        url: connector.authUrl,
        steps: [
          "In the provider developer portal, register an OAuth application and the callback URI shown below.",
          "Configure the client ID and secret in core, then connect your account.",
        ],
      },
    };
  }
  return providers;
}
