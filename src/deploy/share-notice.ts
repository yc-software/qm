import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { samePerson } from "../directory/person.ts";
import { principalDestination } from "../reach/reach.ts";
import { parseScopeId, type Permission, type ScopeId } from "../types.ts";
import { swallow } from "../util/errors.ts";
import { appUrlOf, type PublishedApp } from "./deploy-store.ts";

export async function notifyAppShared(
  deps: { deliveries?: Pick<DeliveryStore, "enqueue">; publicWebUrl?: string; deployAppsDomain?: string },
  publishedApp: PublishedApp | Promise<PublishedApp | null>,
  scope: ScopeId,
  permission: Permission | null,
  by: string,
): Promise<void> {
  try {
    const d = await publishedApp;
    const grantee = parseScopeId(scope);
    if (
      !d ||
      !deps.deliveries ||
      !permission ||
      grantee.kind !== "personal" ||
      !grantee.ref ||
      samePerson(grantee.ref, by)
    )
      return;
    const slug = d.name ?? d.id;
    const url = appUrlOf(d, { sharedWebUrl: deps.publicWebUrl, appsDomain: deps.deployAppsDomain });
    await deps.deliveries.enqueue({
      destination: principalDestination(grantee.ref, by),
      text: `${by} gave you access to the app "${d.displayName ?? slug}"${permission === "write" ? " (you can also manage it)" : ""}.${url ? ` Open it: ${url}` : ""}`,
      idempotencyKey: `deploy-shared:${d.id}:${grantee.ref.toLowerCase()}:${permission}:${Math.floor(Date.now() / 86_400_000)}`,
    });
  } catch (error) {
    swallow("deploy: share notice", error);
  }
}
