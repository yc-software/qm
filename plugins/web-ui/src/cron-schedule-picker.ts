import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { CronView } from "./crons";
import {
  browserTimezone,
  formatCronDateTime,
  presetCron,
  presetNextRuns,
  schedulePreset,
  WEEKDAYS,
  type SchedulePreset,
} from "./cron-format";

type ScheduleKind = SchedulePreset["kind"] | "custom";

export interface ScheduleDraft {
  kind: ScheduleKind;
  hour: number;
  minute: number;
  day: number;
  expression: string;
  timezone: string;
}

const SCHEDULE_KINDS: Array<{ value: ScheduleKind; label: string }> = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
];

export function draftFromSchedule(schedule: CronView["schedule"]): ScheduleDraft {
  const preset = schedule.cron ? schedulePreset(schedule.cron) : null;
  const draft: ScheduleDraft = {
    kind: schedule.cron ? (preset?.kind ?? "custom") : "daily",
    hour: 9,
    minute: 0,
    day: 1,
    expression: schedule.cron?.trim() ?? "0 9 * * *",
    timezone: schedule.timezone?.trim() || browserTimezone() || "UTC",
  };
  if (preset) {
    draft.minute = preset.minute;
    if (preset.kind !== "hourly") draft.hour = preset.hour;
    if (preset.kind === "weekly") draft.day = preset.day;
  }
  return draft;
}

function draftPreset(draft: ScheduleDraft): SchedulePreset | null {
  if (draft.kind === "custom") return null;
  if (draft.kind === "hourly") return { kind: "hourly", minute: draft.minute };
  if (draft.kind === "weekly") return { kind: "weekly", day: draft.day, hour: draft.hour, minute: draft.minute };
  return draft.kind === "daily"
    ? { kind: "daily", hour: draft.hour, minute: draft.minute }
    : { kind: "weekdays", hour: draft.hour, minute: draft.minute };
}

function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  return intl.supportedValuesOf?.("timeZone") ?? [];
}

export interface SchedulePickerHooks {
  change: (patch: Partial<ScheduleDraft>) => void;
  save: (schedule: { cron: string; timezone: string }) => void;
  cancel: () => void;
}

export function schedulePicker(draft: ScheduleDraft, hooks: SchedulePickerHooks): TemplateResult {
  const preset = draftPreset(draft);
  const runs = preset ? presetNextRuns(preset, draft.timezone) : [];
  const time = `${String(draft.hour).padStart(2, "0")}:${String(draft.minute).padStart(2, "0")}`;
  const onTime = (e: Event) => {
    const [hour, minute] = (e.currentTarget as HTMLInputElement).value.split(":").map(Number);
    if (Number.isInteger(hour) && Number.isInteger(minute)) hooks.change({ hour: hour!, minute: minute! });
  };
  return html`<form
    class="cron-card cron-schedule-form"
    @submit=${(e: SubmitEvent) => {
      e.preventDefault();
      const preset = draftPreset(draft);
      hooks.save({
        cron: preset ? presetCron(preset) : draft.expression.trim().split(/\s+/).join(" "),
        timezone: draft.timezone,
      });
    }}
    @keydown=${(e: KeyboardEvent) => e.key === "Escape" && hooks.cancel()}
  >
    <div class="cron-segments" role="radiogroup" aria-label="How often">
      ${SCHEDULE_KINDS.map(
        (k) =>
          html`<button
            type="button"
            role="radio"
            aria-checked=${draft.kind === k.value ? "true" : "false"}
            class=${draft.kind === k.value ? "active" : ""}
            data-autofocus=${draft.kind === k.value ? "schedule" : nothing}
            @click=${() => hooks.change({ kind: k.value })}
          >
            ${k.label}
          </button>`,
      )}
    </div>
    <div class="cron-schedule-fields">
      ${
        draft.kind === "hourly"
          ? html`<label
              >Minute past the hour<input
                type="number"
                min="0"
                max="59"
                .value=${live(String(draft.minute))}
                @change=${(e: Event) => {
                  const minute = Number((e.currentTarget as HTMLInputElement).value);
                  if (Number.isInteger(minute) && minute >= 0 && minute <= 59) hooks.change({ minute });
                }}
            /></label>`
          : nothing
      }
      ${
        draft.kind === "weekly"
          ? html`<label
              >Day<select
                @change=${(e: Event) => hooks.change({ day: Number((e.currentTarget as HTMLSelectElement).value) })}
              >
                ${WEEKDAYS.map((name, i) => html`<option value=${i} ?selected=${draft.day === i}>${name}</option>`)}
              </select></label
            >`
          : nothing
      }
      ${
        draft.kind === "daily" || draft.kind === "weekdays" || draft.kind === "weekly"
          ? html`<label>Time<input type="time" .value=${live(time)} @change=${onTime} /></label>`
          : nothing
      }
      ${
        draft.kind === "custom"
          ? html`<label class="cron-expression"
              >Cron expression<input
                class="mono"
                .value=${live(draft.expression)}
                placeholder="0 9 * * 1-5"
                @change=${(e: Event) => hooks.change({ expression: (e.currentTarget as HTMLInputElement).value })}
              /><span class="hint">minute · hour · day of month · month · day of week</span></label
            >`
          : nothing
      }
      <label
        >Timezone<input
          list="cron-timezones"
          .value=${live(draft.timezone)}
          @change=${(e: Event) => hooks.change({ timezone: (e.currentTarget as HTMLInputElement).value.trim() })}
        /><datalist id="cron-timezones">
          ${timezoneOptions().map((tz) => html`<option value=${tz}></option>`)}
        </datalist></label
      >
    </div>
    ${
      runs.length
        ? html`<div class="cron-next-runs">
            <span>Next runs</span>
            ${runs.map((at) => html`<span>${formatCronDateTime(at, Date.now(), draft.timezone)}</span>`)}
          </div>`
        : nothing
    }
    <div class="cron-card-actions">
      <button class="btn" type="button" @click=${() => hooks.cancel()}>Cancel</button>
      <button class="btn primary" type="submit">Save</button>
    </div>
  </form>`;
}
