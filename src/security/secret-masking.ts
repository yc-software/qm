const NON_SECRET_ENV_KEYS = new Set([
  "AGENT_API_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "BROWSE_LAB_MAX_STEPS",
  "BROWSE_LAB_MODEL",
  "BROWSE_LAB_BASE_URL",
  "BROWSE_LAB_MODEL_PROVIDER",
  "PYTHONUNBUFFERED",
  "NO_PROXY",
  "no_proxy",
]);

const MIN_MASKABLE_LENGTH = 8;

export function createSecretValueMasker(env: Record<string, string> | undefined): (text: string) => string {
  const variants: Array<{ needle: string; label: string }> = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (NON_SECRET_ENV_KEYS.has(key) || value.length < MIN_MASKABLE_LENGTH) continue;
    variants.push({ needle: value, label: key });
    const uri = encodeURIComponent(value);
    if (uri !== value) variants.push({ needle: uri, label: key });
    variants.push({ needle: Buffer.from(value, "utf8").toString("base64").replace(/=+$/, ""), label: key });
    variants.push({ needle: Buffer.from(value, "utf8").toString("base64url"), label: key });
  }
  if (!variants.length) return (text) => text;
  variants.sort((a, b) => b.needle.length - a.needle.length);
  return (text) => {
    for (const { needle, label } of variants) {
      if (text.includes(needle)) text = text.split(needle).join(`<redacted:${label}>`);
    }
    return text;
  };
}

export class MaskedExecutionError extends Error {}

export function createExactSecretValueMasker(values: Iterable<string>): (text: string) => string {
  const secrets = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!secrets.length) return (text) => text;
  const pattern = new RegExp(secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => text.replace(pattern, () => "<redacted:credential>");
}

export function executionSecretEnv(
  env: Record<string, string> | undefined,
  fields: readonly { key: string; value: string; secret?: boolean }[] = [],
): Record<string, string> {
  const secrets = Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !NON_SECRET_ENV_KEYS.has(key)));
  const injected = fields.filter((field) => env?.[field.key] === field.value);
  for (const field of injected) if (field.secret === false) delete secrets[field.key];
  for (const field of injected) if (field.secret !== false) secrets[field.key] = field.value;
  return secrets;
}
