import type { CandidateDestination, Cron, Monitor } from "../../types.ts";
import type { DirectoryChannel, DirectoryMember } from "../../directory/directory-store.ts";

export function deliveryMenu(candidates: CandidateDestination[], defaultKey: string | undefined): string {
  const lines = candidates.map(
    (c) =>
      `- ${c.label}${c.key === defaultKey ? " (default — where we're talking now)" : ""}: destinationKey \`${c.key}\``,
  );
  return [
    "## Where scheduled tasks post",
    "When you schedule a cron here, it delivers to the default below unless you pass a different",
    "`destinationKey` to the `cron` tool on create, or move an existing one with `cron`",
    "action=retarget. A `destinationKey` may only come from this list — these are the destinations",
    "authenticated for this conversation. To schedule something privately for whoever asked instead,",
    'pass `scope:"personal"` (it runs at their personal scope and DMs them).',
    ...lines,
  ].join("\n");
}

export function renderProjectHomeChannel(channelName: string): string {
  const name = channelName.replace(/^#/, "");
  return [
    "## Project home channel",
    `This project is linked to the Slack channel #${name} — that channel is where the project's people follow the work.`,
    `Treat it as the default external audience: schedule deliveries there (the \`cron\` tool's \`channel: "${name}"\`), and when asked to report out or notify the team, post there with \`reach\` (\`channel: "${name}"\`).`,
    "Project membership follows the channel: everyone in the channel is a member of this project, and people joining or leaving the channel join or leave the project with it.",
  ].join("\n");
}

const OBLIGATIONS_CAP = 10;
function cronSchedulePromptLabel(c: Cron): string {
  const schedule = c.schedule;
  if (schedule.cron) return `cron ${schedule.cron}${schedule.timezone ? ` ${schedule.timezone}` : " default timezone"}`;
  return schedule.everyMs != null
    ? `every ${Math.max(1, Math.round(schedule.everyMs / 60_000))}m`
    : `once at ${new Date(schedule.firstFireAt ?? c.createdAt).toISOString()}`;
}

export function renderStandingObligations(crons: Cron[], monitors: Monitor[]): string | null {
  const total = crons.length + monitors.length;
  if (total === 0) return null;
  const snippet = (s: string) => (s.length > 100 ? `${s.slice(0, 97)}…` : s).replace(/\s+/g, " ");
  const lines = [
    ...crons
      .slice(0, OBLIGATIONS_CAP)
      .map(
        (c) =>
          `- cron \`${c.id}\`${c.title ? ` "${c.title}"` : ""} (${cronSchedulePromptLabel(c)}, owner ${c.owner}): ${snippet(c.action ?? c.message ?? "")}`,
      ),
    ...monitors.slice(0, OBLIGATIONS_CAP).map((m) => `- job watch on \`${m.processId}\`: ${snippet(m.command)}`),
  ];
  return [
    "## Already scheduled here",
    "Standing work set up for this conversation — it exists, don't re-create it. Pause one of **yours** that's stale or done with `cron` action=disable.",
    ...lines,
    ...(total > lines.length ? [`…and ${total - lines.length} more — \`cron\` action=list.`] : []),
  ].join("\n");
}

const REACH_ROSTER_CAP = 30;
export function renderReachRoster(channels: DirectoryChannel[], displayName: string): string | null {
  if (channels.length === 0) return null;
  const shown = channels
    .slice(0, REACH_ROSTER_CAP)
    .map((c) => `#${c.name}`)
    .join(", ");
  const more =
    channels.length > REACH_ROSTER_CAP ? ` …and ${channels.length - REACH_ROSTER_CAP} more — name one to check` : "";
  return [
    "## Other computers you can reach",
    `Rooms you and ${displayName} share: ${shown}${more}`,
    "This conversation's computer is where you work. Other rooms' computers are places you visit:",
    'read, search, fetch — don\'t rearrange. Run a command there with execute(scope: "#room").',
    "Say where anything you bring back came from.",
  ].join("\n");
}

const ROSTER_CAP = 20;
export function renderConversationRoster(members: DirectoryMember[]): string | null {
  if (members.length === 0) return null;
  const shown = members.slice(0, ROSTER_CAP);
  const lines = shown.map((m) => `- ${m.displayName} (${m.principalId})`);
  const more = members.length > ROSTER_CAP ? `\n…and ${members.length - ROSTER_CAP} more in this conversation.` : "";
  return (
    [
      "## Who's in this conversation",
      "The people party to this conversation, from the company directory. Each is a distinct, real person — when a request names someone, it means this specific person, not anyone who merely posted here:",
      ...lines,
    ].join("\n") + more
  );
}

export function currentTimeBlock(timezone: string, nowMs: number): string {
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(
      nowMs,
    );
  } catch {
    return "";
  }
  return [
    "## The user's local time",
    `It is currently ${local} for this user (timezone ${timezone}). Read "today", "tonight", "9am my time" and similar against this timezone unless they say otherwise.`,
  ].join("\n");
}
