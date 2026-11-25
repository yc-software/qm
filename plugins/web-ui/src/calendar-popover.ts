import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import DOMPurify from "dompurify";
import { AlignLeft, ArrowUpRight, Calendar as CalendarIcon, Check, CircleHelp, MapPin, Users, Video, X } from "lucide";
import { icon } from "./icons";
import { initials, photoTpl } from "./ui";
import { speakerAvatar } from "./speaker-avatars";
import type { Calendar, CalendarEvent, Reply, ResponseStatus } from "./calendar-api";
import { eventSpan, whenLabel } from "./calendar-layout";

export interface Popover {
  event: CalendarEvent;
  rect: DOMRect;
  busy: boolean;
  error: string;
}

export interface PopoverActions {
  close: () => void;
  respond: (status: Reply) => void;
}

const REPLIES: [Reply, string][] = [
  ["accepted", "Yes"],
  ["declined", "No"],
  ["tentative", "Maybe"],
];

function descriptionTpl(text: string): TemplateResult {
  const fragment = DOMPurify.sanitize(text, {
    ALLOWED_TAGS: ["a", "b", "strong", "i", "em", "u", "br", "p", "ul", "ol", "li", "span"],
    ALLOWED_ATTR: ["href"],
    RETURN_DOM_FRAGMENT: true,
  });
  for (const link of fragment.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  const holder = document.createElement("div");
  holder.append(fragment);
  return html`${unsafeHTML(holder.innerHTML)}`;
}

function statusIcon(status: ResponseStatus): TemplateResult | typeof nothing {
  if (status === "accepted") return html`<span class="cal-rsvp-mark is-yes" title="Going">${icon(Check, 9)}</span>`;
  if (status === "declined") return html`<span class="cal-rsvp-mark is-no" title="Not going">${icon(X, 9)}</span>`;
  if (status === "tentative")
    return html`<span class="cal-rsvp-mark is-maybe" title="Maybe">${icon(CircleHelp, 9)}</span>`;
  return nothing;
}

function guestsTpl(event: CalendarEvent): TemplateResult | typeof nothing {
  if (!event.attendees.length) return nothing;
  const count = (status: ResponseStatus): number =>
    event.attendees.filter((person) => person.responseStatus === status).length;
  const summary = [
    count("accepted") && `${count("accepted")} yes`,
    count("declined") && `${count("declined")} no`,
    count("tentative") && `${count("tentative")} maybe`,
    count("needsAction") && `${count("needsAction")} awaiting`,
  ].filter(Boolean);
  return html`<div class="cal-pop-row">
    ${icon(Users, 15)}
    <div class="cal-pop-guests">
      <div>${event.attendees.length} ${event.attendees.length === 1 ? "guest" : "guests"}</div>
      <div class="cal-pop-muted">${summary.join(", ")}</div>
      <ul>
        ${event.attendees.map(
          (person) =>
            html`<li>
              <span class="cal-avatar" aria-hidden="true"
                >${initials(person.name || person.email)}${photoTpl(speakerAvatar(person.email.toLowerCase()))}${statusIcon(person.responseStatus)}</span
              >
              <span class="cal-guest-name">
                <span>${person.name || person.email}${person.self ? " (you)" : ""}</span>
                ${person.organizer ? html`<span class="cal-pop-muted">Organizer</span>` : nothing}
              </span>
            </li>`,
        )}
      </ul>
    </div>
  </div>`;
}

function footTpl(pop: Popover, act: PopoverActions): TemplateResult | typeof nothing {
  const reply = pop.event.selfResponse;
  if (!reply) return nothing;
  return html`<div class="cal-pop-foot">
    <span>Going?</span>
    <div class="cron-segments cal-rsvp" role="radiogroup" aria-label="Your response">
      ${REPLIES.map(
        ([status, label]) =>
          html`<button
            type="button"
            role="radio"
            aria-checked=${reply === status}
            class=${reply === status ? "active" : ""}
            ?disabled=${pop.busy}
            @click=${() => act.respond(status)}
          >
            ${label}
          </button>`,
      )}
    </div>
  </div>`;
}

export function popoverTpl(pop: Popover, calendars: Calendar[], act: PopoverActions): TemplateResult {
  const { event } = pop;
  const calendar = calendars.find((item) => item.id === event.calendarId);
  const locationUrl = event.location?.startsWith("https://") ? event.location : "";
  const title = event.title || "(No title)";
  return html`<div
    class="cal-pop"
    role="dialog"
    aria-label=${title}
    tabindex="-1"
    @keydown=${(e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      act.close();
    }}
  >
    <div class="cal-pop-actions">
      ${
        event.htmlLink
          ? html`<a
              class="icon-btn compact subtle"
              href=${event.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open in Google Calendar"
              title="Open in Google Calendar"
              >${icon(ArrowUpRight, 15)}</a
            >`
          : nothing
      }
      <button class="icon-btn compact subtle" type="button" aria-label="Close" title="Close" @click=${act.close}>
        ${icon(X, 15)}
      </button>
    </div>
    <div class="cal-pop-head" style=${`--ev:${event.color}`}>
      <span class="cal-swatch"></span>
      <div>
        <h2 class=${event.selfResponse === "declined" ? "is-declined" : ""}>${title}</h2>
        <div class="cal-pop-muted">${whenLabel(eventSpan(event))}</div>
      </div>
    </div>
    ${
      event.meetUrl
        ? html`<a class="btn primary cal-meet" href=${event.meetUrl} target="_blank" rel="noopener noreferrer"
            >${icon(Video, 14)}<span>Join with Google Meet</span></a
          >`
        : nothing
    }
    ${
      event.location
        ? html`<div class="cal-pop-row">
            ${icon(MapPin, 15)}
            ${
              locationUrl
                ? html`<a href=${locationUrl} target="_blank" rel="noopener noreferrer">${event.location}</a>`
                : html`<span>${event.location}</span>`
            }
          </div>`
        : nothing
    }
    ${guestsTpl(event)}
    ${
      event.description
        ? html`<div class="cal-pop-row">
            ${icon(AlignLeft, 15)}
            <div class="cal-pop-text">${descriptionTpl(event.description)}</div>
          </div>`
        : nothing
    }
    ${calendar ? html`<div class="cal-pop-row">${icon(CalendarIcon, 15)}<span>${calendar.name}</span></div>` : nothing}
    ${pop.error ? html`<div class="cal-pop-error" role="alert">${pop.error}</div>` : nothing} ${footTpl(pop, act)}
  </div>`;
}
