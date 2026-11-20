import { appHandleSchema, appLabelLimitError } from "../../../tenants/app-handle.ts";
import { noteTenantAppHandle, tenantAppHandle } from "../../../tenants/settings.ts";
import { parseScopeId } from "../../../types.ts";
import type { AdminResource } from "../admin-resources.ts";

export const appHandleResource: AdminResource = {
  id: "app-handle",
  kind: "custom",
  target: "org",
  authz: "org-admin",
  readKey: "appHandle",
  get: () => tenantAppHandle() ?? "",
  apply: async (ctx, _actor, scope) => {
    if (parseScopeId(scope).kind !== "org") return { error: "the app handle is org-wide; target an org scope" };
    const setAppHandle = ctx.deps.directory?.setAppHandle;
    if (!setAppHandle) return { error: "app handles are not available on this install", status: 404 };
    const parsed = appHandleSchema.safeParse(String((ctx.body as { handle?: unknown })?.handle ?? "").trim());
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "invalid handle" };
    for (const d of await ctx.app.listApps()) {
      const problem = appLabelLimitError(parsed.data, d.name ?? d.id);
      if (problem) return { error: problem };
    }
    const outcome = await setAppHandle(parsed.data);
    if (outcome === "taken") return { error: "another workspace already uses that handle", status: 409 };
    if (outcome === "app_taken")
      return {
        error: "with that handle, one of this workspace's apps would get the same address as another workspace's app",
        status: 409,
      };
    noteTenantAppHandle(parsed.data);
    return { ok: true };
  },
};
