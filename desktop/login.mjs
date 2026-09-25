import { createHash, randomBytes } from "node:crypto";

export function createLogin(instance, now = Date.now(), loginUrl) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const url = new URL("/auth/desktop", instance);
  url.searchParams.set("challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("state", state);
  let destination = url;
  if (loginUrl) {
    const login = new URL(loginUrl);
    if (
      login.origin === url.origin &&
      (login.pathname === "/auth/trusted/login" ||
        (login.pathname === "/auth/login" && login.searchParams.get("provider") === "primary"))
    ) {
      destination = new URL(login.pathname, url);
      if (login.pathname === "/auth/login") destination.searchParams.set("provider", "primary");
      destination.searchParams.set("returnTo", url.pathname + url.search);
    }
  }
  return { verifier, state, url: destination.href, instance, expiresAt: now + 10 * 60_000 };
}

export function loginCallback(value, pending, now = Date.now()) {
  if (!pending || now >= pending.expiresAt || typeof value !== "string" || value.length > 12288) return null;
  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if (
      url.protocol !== "qm-desktop:" ||
      url.hostname !== "auth" ||
      url.pathname !== "/callback" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.get("state") !== pending.state ||
      !code ||
      code.length > 8192
    )
      return null;
    return code;
  } catch {
    return null;
  }
}
