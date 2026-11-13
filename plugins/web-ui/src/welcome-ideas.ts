import type { SuggestedActivity } from "../../chassis/src/suggested-activities.ts";
import type { WelcomeProfile } from "../../chassis/src/welcome-profile.ts";

export const welcomeIdeasPrompt = `Help me explore what I can do with QM. Skip onboarding and setup in this conversation; go straight to ideas. Keep your first response around 200 words: three concrete example bullets, followed by an offer to tailor more ideas and at most two focused questions. Avoid repeating permission disclaimers. Show these workflows as possibilities, not tasks to execute now:

1. Recruiting: Check a job board every morning for new engineering candidates with Rust experience, notify me in Slack, and prepare Gmail outreach drafts in the tone of my previous emails.
2. Building: Help implement a Stripe integration and prepare a pull request for my cofounder to review.
3. Sales: Build a pipeline dashboard with prospects from the web, matches based on what our company does, outreach drafts for my review, and inbound from my inbox.

Then offer to help come up with more ideas tailored to my goals and our company's current needs. Combine available company context and memory, and prefer my recent statements over old information; if tools or records are unavailable, continue with what you know. If context is missing, ask one or two focused questions. Suggest a few concrete next steps and help me choose one. Only discuss the examples for now; do not set up automations, send outreach, or modify external systems until I choose what to do.`;

const WELCOME_IDEA_COUNT = 5;

export interface WelcomeIdeaRow {
  activity: SuggestedActivity;
  note?: { text: string; fresh: boolean };
}

export function welcomeIdeaRows(
  profile: WelcomeProfile,
  connected: ReadonlyArray<{ id: string; name: string }>,
  justConnected: string,
): WelcomeIdeaRow[] {
  const row = (idea: WelcomeProfile["ideas"][number], note?: WelcomeIdeaRow["note"]): WelcomeIdeaRow => ({
    activity: { id: idea.id, icon: idea.icon, title: idea.title, prompt: idea.title },
    ...(note ? { note } : {}),
  });
  let rows = profile.ideas.map((idea) => row(idea, idea.src ? { text: idea.src, fresh: false } : undefined));
  for (const app of connected) {
    const adds = profile.connectors[app.id] ?? [];
    const replaced = new Set(adds.map((idea) => idea.replaces));
    const fresh = app.id === justConnected;
    rows = [
      ...adds.map((idea) => row(idea, { text: `${fresh ? "New · " : ""}from ${app.name}`, fresh })),
      ...rows.filter((existing) => !replaced.has(existing.activity.id)),
    ];
  }
  return rows.slice(0, WELCOME_IDEA_COUNT);
}
