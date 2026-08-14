import { validEmail } from "../../../plugins/chassis/src/auth-email.ts";

export const DEFAULT_DEV_ADMIN_PRINCIPAL = "dev-admin@example.test";

export function emailAdminsFromSeed(raw: string | undefined): string[] {
  const principals: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const separator = entry.lastIndexOf(":");
    const principal = entry.slice(0, separator).trim().toLowerCase();
    const role = entry.slice(separator + 1).trim();
    if (role === "org_admin" && validEmail(principal) && !principals.includes(principal)) principals.push(principal);
  }
  return principals;
}

export function selectEmailAdmin(candidates: readonly string[], explicit: string | undefined): string {
  const selected = (explicit ?? "").trim().toLowerCase();
  if (selected) return candidates.includes(selected) ? selected : "";
  return candidates.length === 1 ? candidates[0]! : "";
}
