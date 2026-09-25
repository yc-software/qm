export const SIGNIN_REQUIRED_EVENT = "webui:signin-required";

export function currentInAppLocation(location: Pick<Location, "pathname" | "search" | "hash">): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function signinRedirect(
  loginUrl: unknown,
  location: Pick<Location, "origin" | "pathname" | "search" | "hash">,
): string | null {
  if (typeof loginUrl !== "string") return null;
  try {
    const target = new URL(loginUrl, location.origin);
    if (target.origin !== location.origin || target.pathname !== "/auth/login") return null;
    target.searchParams.set("returnTo", currentInAppLocation(location));
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}
