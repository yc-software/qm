import type { App } from "../api/app-types.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { principalDestination } from "../reach/reach.ts";
import { uuidSchema } from "../util/ids.ts";
import { parseScopeId, scopeId, type ActorAssertion, type Destination } from "../types.ts";

type Request = NonNullable<Destination["deploymentAccess"]>;

export function parseDeployAccess(value: string): Request {
  if (value.length > 2000) throw new Error("Invalid access request.");
  const r = JSON.parse(value) as Request;
  if (
    !r ||
    Object.keys(r).length !== 2 ||
    typeof r.deploymentId !== "string" ||
    !uuidSchema.safeParse(r.deploymentId).success ||
    typeof r.requesterId !== "string" ||
    !/^[^\s\p{Cc}<>|:]{1,320}$/u.test(r.requesterId)
  )
    throw new Error("Invalid access request.");
  return r;
}

export async function decideDeploymentAccess(
  app: App,
  identity: IdentityService,
  value: string,
  assertion: ActorAssertion,
  approve: boolean,
): Promise<string> {
  const { deploymentId, requesterId } = parseDeployAccess(value);
  await identity.refresh(true);
  const actor = identity.resolve(assertion);
  if (!identity.isInternal(actor)) throw new Error("Only the app's owner can decide this request.");
  const home = await app.getArtifactHome("deploy", deploymentId);
  if (
    !home ||
    !(await (parseScopeId(home.ownerScopeId).kind === "personal"
      ? app.belongsToScope(actor.id, home.ownerScopeId)
      : app.canManageArtifactHome(home.ownerScopeId, home.createdBy, actor.id)))
  )
    throw new Error("Only the app's owner can decide this request.");
  const d = await app.getDeployment(deploymentId);
  if (!d) throw new Error("That app no longer exists.");
  const label = d.displayName ?? d.name ?? d.id;
  if (approve) {
    const grantee = scopeId("personal", requesterId);
    const existing = (await app.deploymentGrantees(deploymentId)).find(
      (g) => g.scope === grantee && g.permission === "write",
    );
    await app.grant({
      ownerScopeId: home.ownerScopeId,
      ref: home.grantRef,
      granteeScopeId: grantee,
      permission: existing?.permission ?? "read",
      grantedBy: actor.id,
    });
    return `Approved. ${requesterId} can now open "${label}".`;
  }
  await app.enqueueDelivery({
    destination: principalDestination(requesterId, actor.id),
    text: `${actor.id} declined your request for access to "${label}".`,
    idempotencyKey: `deploy-declined:${deploymentId}:${requesterId.toLowerCase()}:${Math.floor(Date.now() / 86_400_000)}`,
  });
  return `Declined. ${requesterId} was told.`;
}
