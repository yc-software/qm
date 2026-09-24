import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { samePerson } from "../directory/person.ts";
import { principalDestination } from "../reach/reach.ts";
import { parseScopeId, type Permission, type ScopeId, type Destination } from "../types.ts";
import { swallow } from "../util/errors.ts";
import { publicUrlOf, type Deployment } from "./deploy-store.ts";

export async function enqueueDeploymentNotice(
  enqueue: (input: { destination: Destination; text: string; idempotencyKey: string }) => Promise<unknown>,
  input: { destination: Destination; text: string; idempotencyKey: string },
): Promise<void> {
  await enqueue({
    ...input,
    destination: { ...input.destination, type: "app-notice" },
    idempotencyKey: `web:${input.idempotencyKey}`,
  });
  await enqueue(input).catch((error) => swallow("deploy: optional Slack notice", error));
}

export async function notifyDeploymentShared(
  deps: { deliveries?: Pick<DeliveryStore, "enqueue">; publicWebUrl?: string; deployAppsDomain?: string },
  deployment: Deployment | Promise<Deployment | null>,
  scope: ScopeId,
  permission: Permission | null,
  by: string,
): Promise<void> {
  try {
    const d = await deployment;
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
    const url = deps.deployAppsDomain
      ? `https://${slug}.${deps.deployAppsDomain}/`
      : (publicUrlOf(d.endpoint) ??
        (deps.publicWebUrl ? `${deps.publicWebUrl.replace(/\/+$/, "")}/d/${slug}/` : undefined));
    await enqueueDeploymentNotice((input) => deps.deliveries!.enqueue(input), {
      destination: { ...principalDestination(grantee.ref, by), deploymentShared: { deploymentId: d.id } },
      text: `${by} gave you access to the app "${d.displayName ?? slug}"${permission === "write" ? " (you can also manage it)" : ""}.${url ? ` Open it: ${url}` : ""}`,
      idempotencyKey: `deploy-shared:${d.id}:${grantee.ref.toLowerCase()}:${permission}:${Math.floor(Date.now() / 86_400_000)}`,
    });
  } catch (error) {
    swallow("deploy: share notice", error);
  }
}
