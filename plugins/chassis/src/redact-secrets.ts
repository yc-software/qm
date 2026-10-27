const SENSITIVE_KEY_SUFFIXES = [
  "token",
  "apikey",
  "secret",
  "accesskey",
  "privatekey",
  "credential",
  "credentials",
  "password",
  "passphrase",
  "authorization",
  "cookie",
];

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function redactSensitiveKeys(value: unknown, sensitive = false): unknown {
  if (sensitive) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactSensitiveKeys(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSensitiveKeys(item, isSensitiveKey(key))]),
  );
}

function redactStructuredDiagnostics(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return value;
    return JSON.stringify(redactSensitiveKeys(parsed));
  } catch {
    return value;
  }
}

const SENSITIVE_ASSIGNMENT = String.raw`["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*`;

export function redactSecrets(value: string): string {
  return redactStructuredDiagnostics(value)
    .replace(new RegExp(`(${SENSITIVE_ASSIGNMENT})\\[[\\s\\S]*?(?:\\]|$)`, "gi"), "$1[redacted]")
    .replace(new RegExp(`(${SENSITIVE_ASSIGNMENT})\\{[\\s\\S]*$`, "gi"), "$1{redacted}")
    .replace(
      new RegExp(`(${SENSITIVE_ASSIGNMENT})(["'])(?:(?:\\\\[\\s\\S])|(?!\\2)[\\s\\S])*(?:\\2|$)`, "gi"),
      "$1$2[redacted]$2",
    )
    .replace(new RegExp(`(${SENSITIVE_ASSIGNMENT})(?!(?:["']|\\[))[^,\\r\\n}\\]]+`, "gi"), "$1[redacted]")
    .replace(/\b(?:Basic|Digest)\s+\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}
