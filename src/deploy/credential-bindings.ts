import { z } from "zod";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import {
  KeychainError,
  type Keychain,
  type KeychainCredentialMeta,
  type DecryptedServiceCredential,
} from "../credentials/keychain.ts";
import type { Deployment, DeploymentCredentialBinding } from "./deploy-store.ts";
import { brokerPathAllowed } from "../api/credential-broker.ts";
import { personalScope } from "../types.ts";

const host = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const header = z.strictObject({
  name: z
    .string()
    .regex(/^(?:authorization|x-api-key|api-key|x-auth-token|x-access-token|x-token-id|x-token-secret)$/i),
  field: z.string().min(1).optional(),
  scheme: z
    .string()
    .max(128)
    .regex(/^[\x20-\x7e]*$/)
    .optional(),
});
const bindingSchema = z.strictObject({
  credentialId: z.string().min(1).max(128),
  ownerId: z.string().min(1),
  host,
  allowedMethods: z.array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])).min(1),
  allowedPathPrefixes: z
    .array(
      z
        .string()
        .max(2048)
        .refine(
          (p) => p.startsWith("/") && !p.startsWith("//") && !/[\\%?#\s\x00-\x1f\x7f]/.test(p) && brokerPathAllowed(p),
        ),
    )
    .min(1),
  headers: z.array(header).min(1).max(16),
});
const bindingsSchema = z.array(bindingSchema).max(32);

export function parseCredentialBindings(input: unknown): DeploymentCredentialBinding[] {
  const parsed = bindingsSchema.safeParse(input);
  if (!parsed.success) throw new KeychainError(400, "invalid credential bindings");
  const ids = parsed.data.map((b) => b.credentialId);
  if (new Set(ids).size !== ids.length) throw new KeychainError(400, "duplicate credential binding");
  return parsed.data;
}

export function validateCredentialBinding(
  binding: DeploymentCredentialBinding,
  credential: KeychainCredentialMeta | null,
  ownerId: string,
): void {
  if (binding.ownerId !== ownerId || !credential || credential.ownerId !== ownerId) {
    throw new KeychainError(403, "every credential must belong to the app owner");
  }
  if (
    credential.kind !== "env" ||
    credential.managed ||
    credential.refresh ||
    (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())
  ) {
    throw new KeychainError(400, "credential is expired or unsupported; only unmanaged env credentials are supported");
  }
  if (credential.host !== undefined && credential.host.toLowerCase() !== binding.host) {
    throw new KeychainError(400, "binding host must match the credential host");
  }
  const fields = credential.fields?.map((f) => f.envKey) ?? (credential.envKey ? [credential.envKey] : []);
  const usedFields = new Set<string>();
  const usedHeaders = new Set<string>();
  for (const h of binding.headers) {
    const field = h.field ?? (!credential.fields ? credential.envKey : undefined);
    const name = h.name.toLowerCase();
    if (!field || !fields.includes(field) || usedFields.has(field) || usedHeaders.has(name)) {
      throw new KeychainError(400, "headers must use distinct known fields and distinct authentication header names");
    }
    usedFields.add(field);
    usedHeaders.add(name);
  }
}

export function ownsPersonalDeployment(deployment: Deployment, ownerId: string): boolean {
  return deployment.createdBy === ownerId && deployment.ownerScopeId === personalScope(ownerId);
}

export async function personalDeploymentCredential(
  deployment: Deployment,
  claims: CapabilityClaims,
  credentialId: string,
  keychain: Keychain,
): Promise<DecryptedServiceCredential | null> {
  if (
    deployment.id !== claims.deployment ||
    deployment.status !== "running" ||
    !ownsPersonalDeployment(deployment, claims.actorId) ||
    claims.scopeId !== personalScope(claims.actorId)
  )
    return null;
  try {
    const bindings = parseCredentialBindings(deployment.credentialBindings ?? []);
    const binding = bindings.find((b) => b.credentialId === credentialId);
    if (!binding) return null;
    let credential: KeychainCredentialMeta | undefined;
    const secret = await keychain.readOwnSecret(claims.actorId, credentialId, (current) => {
      validateCredentialBinding(binding, current, claims.actorId);
      credential = current;
    });
    if (secret === null || !credential) return null;
    const values: unknown = credential.fields ? JSON.parse(secret) : { [credential.envKey!]: secret };
    if (!values || typeof values !== "object" || Array.isArray(values)) return null;
    const authHeaders: Record<string, string> = {};
    for (const h of binding.headers) {
      const field = h.field ?? credential.envKey!;
      const value: unknown = Object.hasOwn(values, field) ? (values as Record<string, unknown>)[field] : undefined;
      if (typeof value !== "string" || !value || /[^\x20-\x7e]/.test(value)) return null;
      const scheme = h.scheme ?? "";
      authHeaders[h.name.toLowerCase()] = `${scheme}${scheme && !scheme.endsWith(" ") ? " " : ""}${value}`;
    }
    return {
      slug: credentialId,
      name: credentialId,
      secret: "",
      delivery: "broker",
      host: binding.host,
      allowedMethods: binding.allowedMethods,
      allowedPathPrefixes: binding.allowedPathPrefixes,
      deployments: true,
      enabled: true,
      authHeaders,
    };
  } catch (error) {
    if (error instanceof KeychainError || error instanceof SyntaxError) return null;
    throw error;
  }
}
