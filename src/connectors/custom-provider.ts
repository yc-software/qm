import { z } from "zod";

export interface CustomOAuthProvider {
  provider: string;
  label: string;
  description?: string;
  authUrl: string;
  tokenUrl: string;
  hosts: string[];
  scopes: string[];
  clientAuth: "body" | "basic";
  scopeParam?: string;
  authParams?: Record<string, string>;
  pkce?: boolean;
  docsUrl?: string;
  setupSteps?: string[];
}

export interface StoredOAuthProvider extends CustomOAuthProvider {
  updatedBy?: string;
  updatedAt: number;
}

const RESERVED_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
];
const paramName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, { error: "must be a query parameter name" });
const httpsUrl = z.url({ protocol: /^https$/, error: "must be an https URL" });
const endpointUrl = httpsUrl.refine((u) => {
  const parsed = new URL(u);
  return !parsed.username && !parsed.password && !u.includes("#");
}, "must not carry credentials or a fragment");
const hostname = z
  .hostname({ error: "must be a bare hostname such as api.example.com" })
  .toLowerCase()
  .regex(/\.[a-z][a-z0-9-]*$/, { error: "must be a bare hostname such as api.example.com" });
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).max(max, { error: `at most ${max} entries` });
const text = (max: number) => z.string().trim().max(max);

const customProviderSchema = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, {
      error: "must be 1-32 characters: lowercase letters, digits and -, starting with a letter",
    }),
    label: text(64).min(1, { error: "is required" }),
    description: text(120).optional(),
    authUrl: endpointUrl.refine((u) => !u.includes("?"), { error: "must not carry a query string; use authParams" }),
    tokenUrl: endpointUrl,
    hosts: list(hostname, 20).min(1, { error: "must list at least one hostname" }),
    scopes: list(text(200).min(1), 100).default([]),
    clientAuth: z.enum(["body", "basic"], { error: "must be body or basic" }).default("body"),
    scopeParam: paramName
      .refine((k) => !RESERVED_PARAMS.includes(k), { error: "cannot set OAuth flow parameters" })
      .optional(),
    authParams: z
      .record(paramName, z.string().max(500))
      .refine((r) => Object.keys(r).length <= 20, { error: "at most 20 entries" })
      .optional(),
    pkce: z.boolean().optional(),
    docsUrl: httpsUrl.optional(),
    setupSteps: list(text(500).min(1), 20).optional(),
  })
  .refine(
    (p) => !Object.keys(p.authParams ?? {}).some((k) => RESERVED_PARAMS.includes(k) || k === (p.scopeParam ?? "scope")),
    { path: ["authParams"], error: "cannot set OAuth flow parameters" },
  );

export function parseCustomOAuthProvider(body: unknown): CustomOAuthProvider | { error: string } {
  const parsed = customProviderSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { error: `${issue.path.join(".") || "provider"}: ${issue.message}` };
  }
  const { hosts, description, scopeParam, authParams, pkce, docsUrl, setupSteps, ...rest } = parsed.data;
  return {
    ...rest,
    hosts: [...new Set(hosts)],
    ...(description ? { description } : {}),
    ...(scopeParam ? { scopeParam } : {}),
    ...(authParams && Object.keys(authParams).length ? { authParams } : {}),
    ...(pkce ? { pkce } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    ...(setupSteps?.length ? { setupSteps } : {}),
  };
}

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, { error: "must be an environment variable name" });
const presetFieldsSchema = z.object({
  clientIdEnv: envName,
  clientSecretEnv: envName,
  hostedDomainEnv: envName.optional(),
  acceptJson: z.boolean().optional(),
  rejectErrorBody: z.boolean().optional(),
  tokenAdapter: z.enum(["slack", "notion"]).optional(),
  consentMode: z.enum(["standard", "admin", "github_app"]).optional(),
  setupConsole: z.string().min(1),
  scopesRationale: z.string().optional(),
});

export type OAuthProviderPresetFields = z.infer<typeof presetFieldsSchema>;

export function parseOAuthProviderPreset(raw: unknown): CustomOAuthProvider & OAuthProviderPresetFields {
  const record = parseCustomOAuthProvider(raw);
  if ("error" in record) throw new Error(`invalid OAuth provider preset: ${record.error}`);
  const fields = presetFieldsSchema.safeParse(raw);
  if (!fields.success) {
    const issue = fields.error.issues[0]!;
    throw new Error(`invalid OAuth provider preset ${record.provider}: ${issue.path.join(".")}: ${issue.message}`);
  }
  return { ...record, ...fields.data };
}
