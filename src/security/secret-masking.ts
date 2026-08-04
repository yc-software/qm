const NON_SECRET_ENV_KEYS = new Set([
  "AGENT_API_URL",
  "AGENT_OUTBOX",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "BROWSE_LAB_MAX_STEPS",
  "BROWSE_LAB_MODEL",
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
