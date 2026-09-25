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
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function browserLoginUrl(value, origin) {
  const url = new URL(value);
  return url.origin === origin && /^\/auth\/(login|trusted\/login)(?:\/|$)/.test(url.pathname);
}

export function loginDestination(value, instance, current = instance) {
  const base = new URL(instance);
  const page = new URL(current || instance);
  const safePage =
    ["https:", "http:"].includes(page.protocol) &&
    page.origin === base.origin &&
    !page.username &&
    !page.password &&
    !page.pathname.startsWith("/auth/");
  let fallback = base.pathname.startsWith("/auth/") ? new URL("/", base).href : base.href;
  if (safePage) fallback = page.href;
  try {
    const login = new URL(value);
    if (!browserLoginUrl(login.href, base.origin)) return fallback;
    const returnTo = login.searchParams.get("returnTo");
    if (!returnTo) return fallback;
    const destination = new URL(returnTo, base.origin);
    if (
      !["https:", "http:"].includes(destination.protocol) ||
      destination.origin !== base.origin ||
      destination.username ||
      destination.password ||
      destination.pathname.startsWith("/auth/")
    )
      return fallback;
    return destination.href;
  } catch {
    return fallback;
  }
}

export function internalUrl(value, origin) {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (
      url.origin === origin && !url.username && !url.password && ["https:", "http:", "blob:"].includes(url.protocol)
    );
  } catch {
    return false;
  }
}
