export function instanceUrl(value) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Use an HTTPS URL, or HTTP for a local dev instance.");
  }
  if (url.username || url.password) throw new Error("Use a URL without embedded credentials.");
  return url.href;
}

export function externalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function browserLoginUrl(value, origin) {
  const url = new URL(value);
  return url.origin === origin && /^\/auth\/(login|trusted\/login)(?:\/|$)/.test(url.pathname);
}
