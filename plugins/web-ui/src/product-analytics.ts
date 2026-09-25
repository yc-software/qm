import type { Me } from "./shell-state";
import type { PostHog, PostHogConfig } from "posthog-js";

let client: PostHog | undefined;
let initialized = false;
let generation = 0;
let currentView = "chats";
let lastCapturedView: string | undefined;
const sent = new Set<string>();
const allowedProperties = new Set([
  "token",
  "distinct_id",
  "$device_id",
  "$user_id",
  "$session_id",
  "$window_id",
  "$groups",
  "$group_type",
  "$group_key",
  "$group_set",
  "$set",
  "$set_once",
  "$anon_distinct_id",
  "$lib",
  "$lib_version",
  "$process_person_profile",
  "$insert_id",
  "company_id",
  "surface",
  "view",
]);

export function stopAnalytics(): void {
  generation++;
  client?.set_config({ before_send: () => null });
  client = undefined;
  sent.clear();
  lastCapturedView = undefined;
  currentView = "chats";
}

export async function initializeAnalytics(me: Me, view = "chats"): Promise<void> {
  currentView = view;
  const current = ++generation;
  client?.set_config({ before_send: () => null });
  client = undefined;
  sent.clear();
  lastCapturedView = undefined;
  if (!me.analytics?.apiKey || me.impersonatedBy) return;
  try {
    const { default: posthog } = await import("posthog-js");
    if (current !== generation) return;
    const options: Partial<PostHogConfig> = {
      api_host: me.analytics.host,
      persistence: "memory",
      bootstrap: { distinctID: JSON.stringify([me.org, me.user]), isIdentifiedID: true },
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      person_profiles: "identified_only",
      save_referrer: false,
      save_campaign_params: false,
      before_send: (event) => {
        if (!event) return null;
        for (const key of Object.keys(event.properties)) {
          if (!allowedProperties.has(key)) delete event.properties[key];
        }
        delete event.properties.$set;
        delete event.properties.$set_once;
        delete event.$set_once;
        delete event.$set;
        return event;
      },
    };
    if (initialized) posthog.set_config({ ...options, token: me.analytics.apiKey });
    else posthog.init(me.analytics.apiKey, options);
    initialized = true;
    if (posthog.get_distinct_id() !== JSON.stringify([me.org, me.user])) posthog.reset();
    posthog.identify(JSON.stringify([me.org, me.user]));
    posthog.group("company", me.org);
    posthog.register({ company_id: me.org, surface: "web" });
    client = posthog;
    capturePageview(currentView);
  } catch {
    client = undefined;
  }
}

export function capturePageview(view: string): void {
  currentView = view;
  if (!client || lastCapturedView === view) return;
  try {
    client.capture("$pageview", { view });
    lastCapturedView = view;
  } catch {
    return;
  }
}

export function captureMessage(runId: string, firstMessage: boolean): void {
  if (!client || sent.has(runId)) return;
  sent.add(runId);
  if (sent.size > 1000) sent.delete(sent.values().next().value!);
  try {
    client.capture("message_sent", { $insert_id: `${runId}:message_sent` });
    if (firstMessage) client.capture("session_started", { $insert_id: `${runId}:session_started` });
  } catch {
    return;
  }
}
