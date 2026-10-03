const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
]);

function diagnosticKeyIsSensitive(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""));
}

function redactStructuredDiagnosticsValue(value: unknown, sensitive = false): unknown {
  if (sensitive) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactStructuredDiagnosticsValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      redactStructuredDiagnosticsValue(item, diagnosticKeyIsSensitive(key)),
    ]),
  );
}

function redactStructuredDiagnostics(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return value;
    return JSON.stringify(redactStructuredDiagnosticsValue(parsed));
  } catch {
    return value;
  }
}

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;
const SECRET_ENV_ASSIGNMENT =
  /(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|CREDENTIALS?)\s*=\s*)(["']?)(?!\d+\b)[^\s"']+\2/g;
const SLACK_TOKEN = /\bxox[abposr]-[A-Za-z0-9-]{10,}/g;

export function redactSecrets(value: string): string {
  return redactStructuredDiagnostics(value)
    .replace(PRIVATE_KEY_BLOCK, "[redacted private key]")
    .replace(URL_PASSWORD, "$1[redacted]@")
    .replace(SECRET_ENV_ASSIGNMENT, "$1$2[redacted]$2")
    .replace(SLACK_TOKEN, "[redacted]")
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)\[[\s\S]*?(?:\]|$)/gi,
      "$1[redacted]",
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)\{[\s\S]*$/gi,
      "$1{redacted}",
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)(["'])(?:(?:\\[\s\S])|(?!\2)[\s\S])*(?:\2|$)/gi,
      "$1$2[redacted]$2",
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|credential|credentials|password|passphrase|secret|token|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?!(?:["']|\[))[^,\r\n}\]]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:Basic|Digest)\s+\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}
