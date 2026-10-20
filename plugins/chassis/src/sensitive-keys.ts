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

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""));
}
