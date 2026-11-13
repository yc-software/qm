import type { ActivitySeeds, SuggestedActivity } from "../../chassis/src/suggested-activities.ts";

export const welcomeIdeasPrompt = `Help me explore what I can do with QM. Skip onboarding and setup in this conversation; go straight to ideas. Keep your first response around 200 words: three concrete example bullets, followed by an offer to tailor more ideas and at most two focused questions. Avoid repeating permission disclaimers. Show these workflows as possibilities, not tasks to execute now:

1. Recruiting: Check a job board every morning for new engineering candidates with Rust experience, notify me in Slack, and prepare Gmail outreach drafts in the tone of my previous emails.
2. Building: Help implement a Stripe integration and prepare a pull request for my cofounder to review.
3. Sales: Build a pipeline dashboard with prospects from the web, matches based on what our company does, outreach drafts for my review, and inbound from my inbox.

Then offer to help come up with more ideas tailored to my goals and our company's current needs. Combine available company context and memory, and prefer my recent statements over old information; if tools or records are unavailable, continue with what you know. If context is missing, ask one or two focused questions. Suggest a few concrete next steps and help me choose one. Only discuss the examples for now; do not set up automations, send outreach, or modify external systems until I choose what to do.`;

export function welcomeActivities(
  seeds: ActivitySeeds,
  connected: ReadonlyArray<{ id: string; name: string }>,
  justConnected: string,
): { activities: SuggestedActivity[]; fresh: Set<string> } {
  let activities = seeds.activities;
  const fresh = new Set<string>();
  for (const app of connected) {
    const adds = seeds.apps[app.id] ?? [];
    const replaced = new Set(adds.map((activity) => activity.replaces));
    if (app.id === justConnected) for (const activity of adds) fresh.add(activity.id);
    activities = [
      ...adds.map(({ replaces: _replaces, ...activity }) => ({ ...activity, source: `from ${app.name}` })),
      ...activities.filter((existing) => !replaced.has(existing.id)),
    ];
  }
  return { activities, fresh };
}
