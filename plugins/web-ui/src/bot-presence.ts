import { html, nothing, svg, type TemplateResult } from "lit";
import type { CoreSession, ProjectIcon } from "./core-bridge";
import { cronNextFire, formatCronDateTime } from "./cron-format";
import { projectIconTpl } from "./project-icon";
import { activityOf } from "./session-list";
import { relTime, sheenLabel, workingWave } from "./ui";

export interface BotCron {
  id: string;
  title?: string;
  action?: string;
  message?: string;
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  enabled: boolean;
  createdAt?: number;
  nextFireAt?: number;
  lastFiredAt?: number;
  lastFireNote?: { text: string; at: number; by?: string } | null;
  runningSince?: number;
}

export type BotState = "working" | "waiting" | "scheduled" | "resting";

export interface BotStatus {
  state: BotState;
  working: CoreSession[];
  running: Array<{ cron: BotCron; since: number }>;
  waiting: CoreSession[];
  recent: CoreSession[];
  upcoming: Array<{ cron: BotCron; at: number }>;
  note: { text: string; at: number; cron: BotCron } | null;
  lastActiveAt: number | null;
}

const STATE_RANK: Record<BotState, number> = { working: 0, waiting: 1, scheduled: 2, resting: 3 };

export const BOT_STATE_LABELS: Record<BotState, string> = {
  working: "Working",
  waiting: "Needs you",
  scheduled: "On watch",
  resting: "Idle",
};

export function botStatus(
  personaId: string,
  sessions: readonly CoreSession[],
  crons: readonly BotCron[] = [],
): BotStatus {
  const mine = sessions.filter((s) => s.personaId === personaId && !s.archived && !s.parentSessionId);
  const working = mine.filter((s) => s.working);
  const waiting = mine.filter((s) => !s.working && (s.awaitingInput || (s.subagents?.waiting ?? 0) > 0));
  const recent = mine.filter((s) => !s.working).sort((a, b) => activityOf(b) - activityOf(a));
  const upcoming = crons
    .flatMap((cron) => {
      const at = cronNextFire({ ...cron, createdAt: cron.createdAt ?? 0 });
      return at === null ? [] : [{ cron, at }];
    })
    .sort((a, b) => a.at - b.at);
  const note =
    crons
      .flatMap((cron) => (cron.lastFireNote?.text.trim() ? [{ ...cron.lastFireNote, cron }] : []))
      .sort((a, b) => b.at - a.at)[0] ?? null;
  const running = crons.flatMap((cron) => (cron.runningSince ? [{ cron, since: cron.runningSince }] : []));
  const last = Math.max(0, ...mine.map(activityOf), ...crons.map((cron) => cron.lastFiredAt ?? 0));
  let state: BotState = "resting";
  if (working.length || running.length) state = "working";
  else if (waiting.length) state = "waiting";
  else if (upcoming.length) state = "scheduled";
  return { state, working, running, waiting, recent, upcoming, note, lastActiveAt: last || null };
}

export function compareBotStatus(a: BotStatus, b: BotStatus): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
}

export function elapsedLabel(since: number, now = Date.now()): string {
  const seconds = Math.floor(Math.max(0, now - since) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function nextRunLabel(at: number, cron: BotCron, now = Date.now()): string {
  return at <= now ? "due now" : formatCronDateTime(at, now, cron.schedule.timezone);
}

export interface BotStatusText {
  lead: string;
  stackedLead: string;
  subject: string;
  time: string;
}

export function botStatusText(
  status: BotStatus,
  titleOf: (session: CoreSession) => string,
  cronTitleOf: (cron: BotCron) => string,
  now = Date.now(),
): BotStatusText {
  if (status.state === "working") {
    const jobs = [
      ...status.working.map((session) => ({
        title: titleOf(session),
        since: session.workingSince ?? activityOf(session),
      })),
      ...status.running.map(({ cron, since }) => ({ title: cronTitleOf(cron), since })),
    ];
    const many = jobs.length > 1;
    return {
      lead: many ? `Working on ${jobs.length} things` : "Working on",
      stackedLead: many ? `Working on ${jobs.length} things` : "Working",
      subject: many ? "" : jobs[0]!.title,
      time: elapsedLabel(Math.min(...jobs.map((job) => job.since)), now),
    };
  }
  if (status.state === "waiting") {
    const many = status.waiting.length > 1;
    return {
      lead: many ? `Waiting on you in ${status.waiting.length} chats` : "Waiting on you in",
      stackedLead: many ? `Waiting on you in ${status.waiting.length} chats` : "Waiting on you",
      subject: many ? "" : titleOf(status.waiting[0]!),
      time: "",
    };
  }
  if (status.state === "scheduled") {
    const next = status.upcoming[0]!;
    const lead = `Next run ${nextRunLabel(next.at, next.cron, now)}`;
    return { lead, stackedLead: lead, subject: cronTitleOf(next.cron), time: "" };
  }
  const lead = status.lastActiveAt ? `Last active ${relTime(status.lastActiveAt)}` : "Not used yet";
  return {
    lead,
    stackedLead: lead,
    subject: status.recent[0] ? titleOf(status.recent[0]) : "",
    time: "",
  };
}

export function botStatusTpl(
  text: BotStatusText,
  state: BotState,
  opts: { open?: (() => void) | null; stacked?: boolean } = {},
): TemplateResult {
  const lead = opts.stacked ? text.stackedLead : text.lead;
  const open = opts.open;
  const body = html`<span class="bot-status-mark"
      >${state === "working" ? workingWave() : html`<span class="bot-status-dot"></span>`}</span
    >
    <span class="bot-status-text" dir="auto"
      ><span class="bot-status-lead">${state === "working" ? sheenLabel(lead, true) : lead}</span>${
        text.subject ? html`<span class="bot-status-subject">${text.subject}</span>` : nothing
      }</span
    >
    ${text.time ? html`<span class="bot-status-time">${text.time}</span>` : nothing}`;
  return open
    ? html`<button class="bot-status" type="button" data-state=${state} @click=${open}>${body}</button>`
    : html`<span class="bot-status" data-state=${state}>${body}</span>`;
}

function hashOf(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return hash >>> 0;
}

const FALLBACK_HUES = [8, 28, 46, 96, 150, 174, 198, 220, 248, 272, 306, 338];
const emojiTints = new Map<string, { hue: number; sat: number } | null>();

function emojiTint(emoji: string): { hue: number; sat: number } | null {
  const known = emojiTints.get(emoji);
  if (known !== undefined) return known;
  let tint: { hue: number; sat: number } | null = null;
  const ctx =
    typeof document === "undefined"
      ? null
      : Object.assign(document.createElement("canvas"), { width: 24, height: 24 }).getContext("2d", {
          willReadFrequently: true,
        });
  if (ctx) {
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, 12, 13);
    const { data } = ctx.getImageData(0, 0, 24, 24);
    let x = 0;
    let y = 0;
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3]! < 128) continue;
      const [r, g, b] = [data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255];
      const max = Math.max(r, g, b);
      const chroma = max - Math.min(r, g, b);
      pixels++;
      if (chroma < 0.12) continue;
      let sector = (r - g) / chroma + 4;
      if (max === r) sector = (g - b) / chroma;
      else if (max === g) sector = (b - r) / chroma + 2;
      const angle = (sector * Math.PI) / 3;
      x += Math.cos(angle) * chroma;
      y += Math.sin(angle) * chroma;
    }
    if (pixels) {
      const strength = Math.hypot(x, y) / pixels;
      const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
      if (strength > 0.03) tint = { hue, sat: Math.min(1, 0.45 + strength * 2.2) };
    }
  }
  emojiTints.set(emoji, tint);
  return tint;
}

export function botTintStyle(bot: { id: string; icon?: ProjectIcon | null }): string {
  const hash = hashOf(bot.id);
  const fallback = { hue: FALLBACK_HUES[hash % FALLBACK_HUES.length]!, sat: bot.icon ? 0.55 : 1 };
  const tint = (bot.icon?.kind === "emoji" ? emojiTint(bot.icon.value) : null) ?? fallback;
  return `--bot-hue:${tint.hue};--bot-sat:${tint.sat}`;
}

function faceTpl(key: string, state: BotState): TemplateResult {
  const hash = hashOf(key);
  const antenna = hash % 3;
  const eyes = (hash >>> 3) % 3;
  const mouth = (hash >>> 6) % 3;
  const antennaTpl = [
    svg`<line x1="16" y1="5.4" x2="16" y2="8.5" /><circle class="fill" cx="16" cy="4" r="1.7" />`,
    svg`<line x1="12.2" y1="8.5" x2="10.6" y2="5.4" /><line x1="19.8" y1="8.5" x2="21.4" y2="5.4" /><circle class="fill" cx="10.3" cy="4.6" r="1.3" /><circle class="fill" cx="21.7" cy="4.6" r="1.3" />`,
    svg`<rect class="fill" x="12" y="5.2" width="8" height="3.3" rx="1.6" />`,
  ][antenna];
  const awake = [
    svg`<circle class="fill" cx="12" cy="16" r="2" /><circle class="fill" cx="20" cy="16" r="2" />`,
    svg`<ellipse class="fill" cx="12" cy="16" rx="1.6" ry="2.5" /><ellipse class="fill" cx="20" cy="16" rx="1.6" ry="2.5" />`,
    svg`<rect class="fill" x="9" y="13.2" width="14" height="5.6" rx="2.8" /><circle class="light" cx="13" cy="16" r="1.1" /><circle class="light" cx="19" cy="16" r="1.1" />`,
  ][eyes];
  const asleep = svg`<path d="M10 15.8q2 1.9 4 0" /><path d="M18 15.8q2 1.9 4 0" />`;
  const mouthTpl = [
    svg`<path d="M12.5 20.6q3.5 2.4 7 0" />`,
    svg`<line x1="13" y1="21.3" x2="19" y2="21.3" />`,
    svg`<rect x="12" y="19.8" width="8" height="3.2" rx="1.6" /><line x1="14.7" y1="19.8" x2="14.7" y2="23" /><line x1="17.3" y1="19.8" x2="17.3" y2="23" />`,
  ][mouth];
  return html`<svg class="bot-face" viewBox="0 0 32 32" aria-hidden="true">
    <g class="antenna">${antennaTpl}</g>
    <rect class="ear" x="2.4" y="14.2" width="3" height="6" rx="1.5" />
    <rect class="ear" x="26.6" y="14.2" width="3" height="6" rx="1.5" />
    <rect class="head" x="5" y="8.2" width="22" height="18.6" rx="7" />
    <g class="bot-face-eyes">${state === "resting" ? asleep : awake}</g>
    <g class="mouth">${mouthTpl}</g>
  </svg>`;
}

export function botAvatarTpl(
  bot: { id: string; icon?: ProjectIcon | null },
  size: number,
  state: BotState | null = null,
): TemplateResult {
  const glyph = projectIconTpl(bot.icon ?? undefined, Math.round(size * 0.58));
  return html`<span
    class="bot-avatar"
    data-state=${state ?? "none"}
    style=${`${botTintStyle(bot)};--bot-size:${size}px`}
  >
    <span class="bot-avatar-tile">${glyph ?? faceTpl(bot.id, state ?? "scheduled")}</span>
    ${state ? html`<span class="bot-presence" aria-hidden="true"></span>` : nothing}
  </span>`;
}
