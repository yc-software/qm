import cronstrue from "cronstrue";
import { CronPattern } from "croner";
import { retainedSnapshot } from "../../agent/context-snapshot.ts";
import { DEFAULT_CRON_TIMEZONE } from "../../cron/schedule.ts";
import type { CandidateDestination, GatewayContext, GrantedHandle, SessionEntry } from "../../types.ts";
import type { Cron, Monitor, Webhook } from "../../triggers/types.ts";
import type { DirectoryChannel, DirectoryMember } from "../../directory/directory-store.ts";

const memberLabel = (m: { principalId: string; displayName: string; slackId?: string }): string =>
  `${m.displayName} (${[m.principalId, m.slackId].filter(Boolean).join(", ")})`;

export function renderSandboxProviders(
  names: readonly string[],
  defaultName?: string,
  listable = true,
  proxied: readonly string[] = [],
): string {
  if (!names.length) return "";
  const listed = [
    ...names.filter((name) => name === defaultName).map((name) => `${name} (default)`),
    ...names.filter((name) => name !== defaultName).toSorted(),
  ];
  const behindProxy = names.filter((name) => proxied.includes(name)).toSorted();
  const network = behindProxy.length
    ? `\nComputers on ${behindProxy.join(", ")} reach the network only through the egress proxy in $HTTPS_PROXY. If it is https://, Python's urllib and http.client fail there (BadStatusLine, RemoteDisconnected); use curl, git, Python requests, or Node with NODE_USE_ENV_PROXY=1.`
    : "";
  return `## Sandboxes\n${listed.join(", ")}.${listable ? " `sandbox list` for details." : ""}${network}`;
}

interface RosterSnapshot {
  roster: Array<{ id: string; name: string }>;
  sessionId: string;
}

export function membershipEvent(
  current: ReadonlyArray<{ principalId: string; displayName: string; slackId?: string }> | undefined,
  history: readonly SessionEntry[],
  sessionId: string,
): { text: string; record?: RosterSnapshot } {
  if (!current) return { text: "" };
  const roster = current
    .map((m) => ({ id: m.principalId, name: m.displayName }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const { previous } = retainedSnapshot(history, rosterOf);
  if (!previous) return { text: "", record: { roster, sessionId } };
  const absentFrom = (list: RosterSnapshot["roster"], id: string) => !list.some((o) => o.id === id);
  const joined = current
    .filter((m) => absentFrom(previous.roster, m.principalId))
    .toSorted((a, b) => a.principalId.localeCompare(b.principalId))
    .map(memberLabel);
  const left = previous.roster.filter((m) => absentFrom(roster, m.id)).map((m) => m.name);
  const parts = [
    joined.length ? `Joined: ${joined.join(", ")}.` : "",
    left.length ? `Left: ${left.join(", ")}.` : "",
  ].filter(Boolean);
  return { text: parts.join(" "), record: { roster, sessionId } };
}

function rosterOf(entry: SessionEntry): RosterSnapshot | undefined {
  const snapshot = (entry.payload as { rosterSnapshot?: Partial<RosterSnapshot> } | null)?.rosterSnapshot;
  return Array.isArray(snapshot?.roster) && typeof snapshot.sessionId === "string"
    ? (snapshot as RosterSnapshot)
    : undefined;
}

export function renderGatewayContext(surface: string | undefined, ctx?: GatewayContext, dmWith?: string): string {
  const gateway = (surface ?? "").trim();
  const location = ctx?.location?.trim();
  const details = Object.entries(ctx?.details ?? {})
    .map(([k, v]) => [k.trim(), String(v).trim()] as const)
    .filter(([k, v]) => k && v)
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const instructions = ctx?.instructions?.trim();
  if (!gateway && !location && details.length === 0 && !instructions) return "";

  const lines = ["## Where you are"];
  const place = gateway ? `${gateway.charAt(0).toUpperCase()}${gateway.slice(1)}` : "";
  if (place && dmWith) lines.push(`${place} DM with ${dmWith}.`);
  else if (place && location) lines.push(`${place}, in ${location}.`);
  else if (place) lines.push(`${place} conversation.`);
  else if (location) lines.push(`In ${location}.`);
  if (details.length) {
    lines.push("Identifiers for this conversation (use these if you need to act on it directly):");
    for (const [k, v] of details) lines.push(`- ${k}: ${v}`);
  }
  if (gateway.toLowerCase() === "web") lines.push("Crons you create here post back here.");
  if (instructions) lines.push(instructions);
  return lines.join("\n");
}

export function sharedFilesSystemSection(handles: readonly GrantedHandle[]): string {
  const total = new Set(handles.map((h) => h.handlePath)).size;
  if (!total) return "";
  return `## Files\n${total} ${total === 1 ? "file is" : "files are"} shared with you; list and read them with the \`files\` tool.`;
}

export function environmentNote(text: string): string {
  if (!text.trim()) return "";
  return `<environment>\n${text.trim()}\n</environment>`;
}

export function senderNote(name: string | undefined): string {
  const n = name?.trim();
  return n ? `This message is from @${n}.` : "";
}

export function deliveryMenu(candidates: CandidateDestination[], defaultKey: string | undefined): string {
  const lines = candidates
    .toSorted((a, b) => a.key.localeCompare(b.key))
    .map(
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EVERY_WEEKDAY_OCCURRENCE = 63;

const clockTime = (hour: number, minute: number): string =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    Date.UTC(2000, 0, 1, hour, minute),
  );

const setIndexes = (field: number[]): number[] => field.flatMap((value, index) => (value ? [index] : []));

function shortCron(expression: string): string {
  const pattern = new CronPattern(expression);
  const [minute, ...moreMinutes] = setIndexes(pattern.minute);
  const weekdays = setIndexes(pattern.dayOfWeek);
  const plain =
    minute !== undefined &&
    !moreMinutes.length &&
    setIndexes(pattern.second).join() === "0" &&
    pattern.starDOM &&
    pattern.starYear &&
    pattern.month.every(Boolean) &&
    !pattern.lastDayOfMonth &&
    !pattern.lastWeekday &&
    weekdays.every((day) => pattern.dayOfWeek[day] === EVERY_WEEKDAY_OCCURRENCE);
  if (!plain) return cronstrue.toString(expression.replaceAll("#L", "L"));
  const days = pattern.starDOW ? "daily" : weekdays.map((day) => WEEKDAYS[day]).join("/");
  return `${setIndexes(pattern.hour)
    .map((hour) => clockTime(hour, minute))
    .join(", ")} ${days}`;
}

function shortInterval(everyMs: number): string {
  for (const [size, unit] of [
    [3_600_000, "h"],
    [60_000, "min"],
    [1000, "s"],
  ] as const) {
    if (everyMs % size === 0) return `every ${everyMs / size} ${unit}`;
  }
  return `every ${everyMs} ms`;
}

function zonedParts(timezone: string, nowMs: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(nowMs);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function scheduleLabel(c: Cron): { label: string; timezone?: string } {
  const schedule = c.schedule;
  const timezone = schedule.timezone ?? DEFAULT_CRON_TIMEZONE;
  if (schedule.cron) return { label: shortCron(schedule.cron), timezone };
  if (schedule.everyMs != null) return { label: shortInterval(schedule.everyMs) };
  const at = zonedParts(timezone, schedule.firstFireAt ?? c.createdAt);
  return {
    label: `once at ${at.year}-${at.month}-${at.day} ${clockTime(Number(at.hour), Number(at.minute))}`,
    timezone,
  };
}

export function renderStandingObligations(crons: Cron[], webhooks: Webhook[], monitors: Monitor[]): string {
  const summary = (text: string) => (text.length > 100 ? `${text.slice(0, 97)}…` : text);
  const schedules = crons
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({ title: c.title || "Untitled scheduled task", ...scheduleLabel(c) }));
  const zones = [...new Set(schedules.flatMap((s) => (s.timezone ? [s.timezone] : [])))];
  const lines = [
    ...schedules.map((s) => `- ${s.title} — ${s.label}${zones.length > 1 && s.timezone ? ` (${s.timezone})` : ""}`),
    ...webhooks.toSorted((a, b) => a.id.localeCompare(b.id)).map((w) => `- Webhook: ${summary(w.action)}`),
    ...monitors
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((m) => `- Job watch: ${summary(m.purpose ?? m.command)}`),
  ];
  return [
    `## Scheduled here${zones.length === 1 ? ` (${zones[0]})` : ""}`,
    ...(lines.length ? lines : ["Nothing is scheduled here."]),
  ].join("\n");
}

const REACH_ROSTER_CAP = 30;
export function renderReachRoster(channels: DirectoryChannel[], displayName: string): string | null {
  if (channels.length === 0) return null;
  const shown = channels
    .toSorted((a, b) => a.channelId.localeCompare(b.channelId))
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
  const shown = members.toSorted((a, b) => a.principalId.localeCompare(b.principalId)).slice(0, ROSTER_CAP);
  const lines = shown.map((m) => `- ${memberLabel(m)}`);
  const more = members.length > ROSTER_CAP ? `\n…and ${members.length - ROSTER_CAP} more in this conversation.` : "";
  return (
    [
      "## Who's in this conversation",
      "Each is a distinct, real person from the company directory; a request naming someone means this person.",
      ...lines,
    ].join("\n") + more
  );
}

export function currentTimeBlock(timezone: string, nowMs: number): string {
  const at = zonedParts(timezone, nowMs);
  return `Local time: ${at.year}-${at.month}-${at.day} ${at.hour!.padStart(2, "0")}:${at.minute} ${at.timeZoneName} (${timezone})`;
}

const SYSTEM_CONTEXT_ORDER = [
  "Where you are",
  "Project home channel",
  "Where scheduled tasks post",
  "Who's in this conversation",
  "Other computers you can reach",
  "Files",
  "Sandboxes",
  "Model access",
  "Scheduled here",
  "Credentials",
  "Skills",
] as const;

export type SystemContextBlocks = Partial<Record<(typeof SYSTEM_CONTEXT_ORDER)[number], string>>;

export function renderSystemContext(blocks: SystemContextBlocks): string {
  return SYSTEM_CONTEXT_ORDER.map((key) => blocks[key] ?? "")
    .filter((block) => block.trim())
    .join("\n\n");
}
