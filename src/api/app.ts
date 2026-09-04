import type { App, AppDeps } from "./app-types.ts";
import { createAppHelpers } from "./app-helpers.ts";
import { createAmbientHelpers } from "./app-ambient.ts";
import { createTurnMethods } from "./app-turn.ts";
import { createSessionMethods } from "./app-sessions.ts";
import { createMessagingMethods } from "./app-messaging.ts";
import { createDeploymentMethods } from "./app-deployments.ts";
import { createSkillMethods } from "./app-skills.ts";

export type { App, AppDeps, ContextSummary, ProjectView, VisibleCron } from "./app-types.ts";
export { deploymentView, STALE_LEASE_GRACE_MS } from "./app-types.ts";
export type { DeployInput } from "../deploy/deploy-service.ts";

export function createApp(deps: AppDeps): App {
  const app = {} as App;
  const helpers = createAppHelpers(deps, app);
  const ambient = createAmbientHelpers(deps, app);
  const methods: App = {
    ...createTurnMethods(deps, helpers, ambient),
    ...createSessionMethods(deps, helpers),
    ...createMessagingMethods(deps, helpers, ambient),
    ...createDeploymentMethods(deps, helpers),
    ...createSkillMethods(deps, helpers),
  };
  return Object.assign(app, methods);
}
