import { addDays, differenceInCalendarDays, format, parseISO } from "date-fns";
import { html, nothing, render } from "lit";
import { live } from "lit/directives/live.js";
import { Video, X } from "lucide";
import {
  createEvent,
  deleteEvent,
  updateEvent,
  type Calendar,
  type CalendarEvent,
  type EventInput,
} from "./calendar-api";
import { restoreDialogFocus } from "./dialog-focus";
import { icon } from "./icons";
import { fieldSelect } from "./ui";
import { switchTrack } from "./switch";
import { errMessage } from "../../chassis/src/errors";
import "./calendar-editor.css";

export type EventEditorOptions = {
  initial?: CalendarEvent;
  draft?: { start: string; end: string; allDay: boolean };
  calendars: Calendar[];
  onSaved: (event: CalendarEvent) => void;
  onDeleted?: (event: CalendarEvent) => void;
};

const HOUR_MS = 3_600_000;

const dateKey = (d: Date): string => format(d, "yyyy-MM-dd");
const timeKey = (d: Date): string => format(d, "HH:mm");
const parseDay = (key: string): Date => parseISO(key);
const shiftDay = (key: string, days: number): string => dateKey(addDays(parseDay(key), days));
const dayGap = (from: string, to: string): number => differenceInCalendarDays(parseDay(to), parseDay(from));
const at = (date: string, time: string): Date => new Date(`${date}T${time}`);

const plainText = (markup: string): string => {
  const doc = new DOMParser().parseFromString(markup, "text/html");
  doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  doc.querySelectorAll("p, div, li").forEach((block) => block.append("\n"));
  return (doc.body.textContent ?? "").trim();
};

const isEmail = (value: string): boolean => {
  const probe = document.createElement("input");
  probe.type = "email";
  probe.value = value;
  return value.includes("@") && probe.checkValidity();
};

function nextSlot(): { start: Date; end: Date } {
  const start = new Date();
  start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
  return { start, end: new Date(start.getTime() + HOUR_MS) };
}

function startingWhen(opts: EventEditorOptions) {
  const source = opts.initial ?? opts.draft;
  if (source?.allDay) {
    const slot = nextSlot();
    return {
      allDay: true,
      startDate: source.start.slice(0, 10),
      endDate: shiftDay(source.end.slice(0, 10), -1),
      startTime: timeKey(slot.start),
      endTime: timeKey(slot.end),
    };
  }
  const slot = source ? { start: new Date(source.start), end: new Date(source.end) } : nextSlot();
  return {
    allDay: false,
    startDate: dateKey(slot.start),
    endDate: dateKey(slot.end),
    startTime: timeKey(slot.start),
    endTime: timeKey(slot.end),
  };
}

export function openEventEditor(opts: EventEditorOptions): void {
  const { initial } = opts;
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog calendar-editor";
  dialog.setAttribute("aria-labelledby", "calendar-editor-heading");
  document.body.append(dialog);

  const writable = opts.calendars.filter((c) => c.writable);
  const when = startingWhen(opts);
  const selfEmails = initial?.attendees.filter((a) => a.self).map((a) => a.email) ?? [];
  const initialGuests = initial?.attendees.filter((a) => !a.self).map((a) => a.email) ?? [];
  let title = initial?.title ?? "";
  let calendarId = initial?.calendarId ?? (writable.find((c) => c.primary) ?? writable[0])?.id ?? "";
  let location = initial?.location ?? "";
  const initialDescription = plainText(initial?.description ?? "");
  let description = initialDescription;
  let guests = [...initialGuests];
  let guestDraft = "";
  let addMeet = false;
  let busy = false;
  let confirmingDelete = false;
  let timeError = "";
  let guestError = "";
  let error = writable.length || initial ? "" : "None of your calendars accept new events.";

  const close = () => {
    dialog.close();
    dialog.remove();
    restoreDialogFocus(opener, () => null);
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!busy) close();
  });

  const shiftEnd = (apply: () => void) => {
    const days = dayGap(when.startDate, when.endDate);
    const span = at(when.endDate, when.endTime).getTime() - at(when.startDate, when.startTime).getTime();
    apply();
    if (when.allDay) {
      when.endDate = shiftDay(when.startDate, Math.max(days, 0));
    } else if (span > 0) {
      const end = new Date(at(when.startDate, when.startTime).getTime() + span);
      when.endDate = dateKey(end);
      when.endTime = timeKey(end);
    }
    timeError = "";
    draw();
  };

  const addGuests = (): boolean => {
    const entered = guestDraft
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);
    const invalid = entered.find((g) => !isEmail(g));
    if (invalid) {
      guestError = `${invalid} isn't a valid email address.`;
      return false;
    }
    guests = [...guests, ...entered.filter((g) => !guests.some((x) => x.toLowerCase() === g.toLowerCase()))];
    guestDraft = "";
    guestError = "";
    return true;
  };

  const range = (): { start: string; end: string } | null => {
    if (when.allDay) {
      if (!when.startDate || !when.endDate) return null;
      return { start: when.startDate, end: shiftDay(when.endDate, 1) };
    }
    if (!when.startDate || !when.endDate || !when.startTime || !when.endTime) return null;
    return {
      start: at(when.startDate, when.startTime).toISOString(),
      end: at(when.endDate, when.endTime).toISOString(),
    };
  };

  const save = async () => {
    if (busy) return;
    error = "";
    const span = range();
    timeError = "";
    if (!span) timeError = "Choose a start and end.";
    else if (span.end <= span.start) timeError = "The event must end after it starts.";
    const guestsOk = addGuests();
    if (!span || timeError || !guestsOk) {
      draw();
      dialog.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      return;
    }
    const fields: EventInput = {
      title: title.trim(),
      start: span.start,
      end: span.end,
      allDay: when.allDay,
      location: location.trim(),
      ...(description.trim() !== initialDescription ? { description: description.trim() } : {}),
    };
    const guestsChanged = guests.join("\n") !== initialGuests.join("\n");
    busy = true;
    draw();
    try {
      const saved = initial
        ? await updateEvent(initial.calendarId, initial.id, {
            ...fields,
            ...(guestsChanged ? { attendees: [...selfEmails, ...guests] } : {}),
            ...(addMeet ? { addMeet } : {}),
          })
        : await createEvent({
            ...fields,
            calendarId,
            ...(guests.length ? { attendees: guests } : {}),
            ...(addMeet ? { addMeet } : {}),
          });
      close();
      opts.onSaved(saved);
    } catch (e) {
      busy = false;
      error = errMessage(e, "Could not save the event.");
      draw();
    }
  };

  const remove = async () => {
    if (!initial || busy) return;
    busy = true;
    error = "";
    draw();
    try {
      await deleteEvent(initial.calendarId, initial.id);
      close();
      opts.onDeleted?.(initial);
    } catch (e) {
      busy = false;
      confirmingDelete = false;
      error = errMessage(e, "Could not delete the event.");
      draw();
    }
  };

  const value = (event: Event): string => (event.currentTarget as HTMLInputElement).value;
  const calendarOf = (id: string): Calendar | undefined => opts.calendars.find((c) => c.id === id);

  const footer = () =>
    confirmingDelete
      ? html`<div class="project-dialog-actions calendar-editor-actions">
          <span class="calendar-editor-confirm">Delete this event?</span>
          <button
            class="btn"
            type="button"
            data-dialog-cancel
            ?disabled=${busy}
            @click=${() => {
              confirmingDelete = false;
              draw();
            }}
          >
            Cancel
          </button>
          <button class="btn danger" type="button" ?disabled=${busy} @click=${() => void remove()}>
            ${busy ? "Deleting…" : "Delete"}
          </button>
        </div>`
      : html`<div class="project-dialog-actions calendar-editor-actions">
          ${
            initial
              ? html`<button
                  class="btn danger calendar-editor-delete"
                  type="button"
                  ?disabled=${busy}
                  @click=${() => {
                    confirmingDelete = true;
                    error = "";
                    draw();
                    dialog.querySelector<HTMLElement>("[data-dialog-cancel]")?.focus();
                  }}
                >
                  Delete
                </button>`
              : nothing
          }
          <button class="btn" type="button" ?disabled=${busy} @click=${close}>Cancel</button>
          <button class="btn primary" type="submit" ?disabled=${busy || (!initial && !writable.length)}>
            ${busy ? "Saving…" : "Save"}
          </button>
        </div>`;

  const draw = () =>
    render(
      html`
        <div class="project-dialog-head">
          <div><h2 id="calendar-editor-heading">${initial ? "Edit event" : "New event"}</h2></div>
          <button class="chip-x" type="button" aria-label="Close" ?disabled=${busy} @click=${close}>
            ${icon(X, 16)}
          </button>
        </div>
        <form
          class="resource-form calendar-editor-form"
          novalidate
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset ?disabled=${busy}>
            <input
              class="calendar-editor-title"
              aria-label="Title"
              placeholder="Add title"
              autocomplete="off"
              .value=${live(title)}
              @input=${(e: Event) => (title = value(e))}
            />
            <div class="calendar-editor-when">
              <label>
                Starts
                <span class="calendar-editor-pair">
                  <input
                    type="date"
                    aria-label="Start date"
                    .value=${live(when.startDate)}
                    @change=${(e: Event) => shiftEnd(() => (when.startDate = value(e)))}
                  />
                  ${
                    when.allDay
                      ? nothing
                      : html`<input
                          type="time"
                          step="900"
                          aria-label="Start time"
                          .value=${live(when.startTime)}
                          @change=${(e: Event) => shiftEnd(() => (when.startTime = value(e)))}
                        />`
                  }
                </span>
              </label>
              <label>
                Ends
                <span class="calendar-editor-pair">
                  <input
                    type="date"
                    aria-label="End date"
                    aria-invalid=${timeError ? "true" : "false"}
                    aria-describedby="calendar-editor-time-error"
                    .value=${live(when.endDate)}
                    @change=${(e: Event) => {
                      when.endDate = value(e);
                      timeError = "";
                      draw();
                    }}
                  />
                  ${
                    when.allDay
                      ? nothing
                      : html`<input
                          type="time"
                          step="900"
                          aria-label="End time"
                          aria-invalid=${timeError ? "true" : "false"}
                          aria-describedby="calendar-editor-time-error"
                          .value=${live(when.endTime)}
                          @change=${(e: Event) => {
                            when.endTime = value(e);
                            timeError = "";
                            draw();
                          }}
                        />`
                  }
                </span>
                ${timeError ? html`<span id="calendar-editor-time-error" class="form-error" role="alert">${timeError}</span>` : nothing}
              </label>
            </div>
            <label class="calendar-editor-switch">
              <input
                type="checkbox"
                class="sr-only"
                .checked=${live(when.allDay)}
                @change=${(e: Event) => {
                  when.allDay = (e.currentTarget as HTMLInputElement).checked;
                  if (when.endDate < when.startDate) when.endDate = when.startDate;
                  timeError = "";
                  draw();
                }}
              />${switchTrack(when.allDay)}<span>All day</span>
            </label>
            <label>
              Calendar
              <span class="calendar-editor-calendar">
                <span
                  class="calendar-editor-dot"
                  style="background:${calendarOf(calendarId)?.color ?? "var(--muted-foreground)"}"
                  aria-hidden="true"
                ></span>
                ${fieldSelect({
                  ariaLabel: "Calendar",
                  value: calendarId,
                  disabled: Boolean(initial) || busy,
                  options: (initial ? opts.calendars.filter((c) => c.id === calendarId) : writable).map(
                    (c) => html`<option value=${c.id} ?selected=${c.id === calendarId}>${c.name}</option>`,
                  ),
                  onChange: (next) => {
                    calendarId = next;
                    draw();
                  },
                })}
              </span>
            </label>
            <label>
              Guests
              <input
                type="email"
                multiple
                placeholder="Add guests by email"
                autocomplete="email"
                aria-invalid=${guestError ? "true" : "false"}
                aria-describedby="calendar-editor-guest-error"
                .value=${live(guestDraft)}
                @input=${(e: Event) => {
                  guestDraft = value(e);
                  if (guestError) {
                    guestError = "";
                    draw();
                  }
                }}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key !== "Enter" || !guestDraft.trim()) return;
                  e.preventDefault();
                  addGuests();
                  draw();
                }}
                @blur=${() => {
                  if (guestDraft.trim()) {
                    addGuests();
                    draw();
                  }
                }}
              />
            </label>
            ${guestError ? html`<p id="calendar-editor-guest-error" class="form-error" role="alert">${guestError}</p>` : nothing}
            ${
              guests.length || initialGuests.length
                ? html`<p class="hint calendar-editor-hint">
                    ${initial ? "Guests are emailed about changes and cancellations." : "Guests get an email invitation when you save."}
                  </p>`
                : nothing
            }
            ${
              guests.length
                ? html`<ul class="calendar-editor-guests" aria-label="Guests">
                    ${guests.map(
                      (guest) =>
                        html`<li>
                          <span>${guest}</span
                          ><button
                            class="chip-x"
                            type="button"
                            aria-label=${`Remove ${guest}`}
                            @click=${() => {
                              guests = guests.filter((g) => g !== guest);
                              draw();
                            }}
                          >
                            ${icon(X, 14)}
                          </button>
                        </li>`,
                    )}
                  </ul>`
                : nothing
            }
            ${
              initial?.meetUrl
                ? html`<a class="btn calendar-editor-meet" href=${initial.meetUrl} target="_blank" rel="noopener"
                    >${icon(Video, 15)}<span>Join with Google Meet</span></a
                  >`
                : html`<label class="calendar-editor-switch">
                    <input
                      type="checkbox"
                      class="sr-only"
                      .checked=${live(addMeet)}
                      @change=${(e: Event) => {
                        addMeet = (e.currentTarget as HTMLInputElement).checked;
                        draw();
                      }}
                    />${switchTrack(addMeet)}<span>Add Google Meet video conferencing</span>
                  </label>`
            }
            <label>
              Location
              <input
                placeholder="Add location"
                autocomplete="off"
                .value=${live(location)}
                @input=${(e: Event) => (location = value(e))}
              />
            </label>
            <label>
              Description
              <textarea
                rows="3"
                placeholder="Add description"
                .value=${live(description)}
                @input=${(e: Event) => (description = value(e))}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void save();
                  }
                }}
              ></textarea>
            </label>
          </fieldset>
          ${error ? html`<p class="form-error" role="alert">${error}</p>` : nothing} ${footer()}
        </form>
      `,
      dialog,
    );

  draw();
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>(".calendar-editor-title")?.focus();
}
