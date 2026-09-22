import * as governance from "./governance.ts";
import * as settings from "./settings.ts";
import * as integrations from "./integrations.ts";
import * as onboarding from "./onboarding.ts";
import type { GovernanceState } from "./governance-state.ts";
import type { SlackSetting } from "./integrations-state.ts";
export * from "./governance.ts";
export { settings, integrations };
export { onboarding };
export * as users from "./users.ts";
export * as userDetail from "./user-detail.ts";
export * as keychain from "./keychain.ts";
export * as metrics from "./metrics.ts";
export * as transcript from "./transcript.ts";
export * as design from "./design.ts";
export * as activity from "./activity.ts";
export * as history from "./history.ts";
export * as artifacts from "./artifacts.ts";
export * as slackActivity from "./slack-activity.ts";
export * as shared from "./shared.ts";

const modules = [governance, settings, integrations];
export const states = new Map<string, GovernanceState | settings.SettingsState | SlackSetting>(
  modules.flatMap((module) => [...module.states]),
);
const owner = (key: string) => modules.find((module) => module.owns(key));
export const owns = (key: string) => !!owner(key);
export const collect = (key: string) => owner(key)!.collect(key);
export const capture = (key: string) => owner(key)!.capture(key);
export const commit = (key: string, body: any) => owner(key)!.commit(key, body);
export const status = (key: string, message: string, tone: string) => owner(key)!.status(key, message, tone);
export const statusKey = (id: string) => modules.map((module) => module.statusKey(id)).find(Boolean);
export function mountCards() {
  modules.forEach((module) => module.mountCards());
  onboarding.mount();
}
