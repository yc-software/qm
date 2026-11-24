import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { AudioLines, Plus } from "lucide";
import "./meeting-note.css";
import { api, type CoreSession } from "./core-bridge";
import { QM_MAC_DOWNLOAD_URL } from "./desktop-computer";
import { icon } from "./icons";
import { markdown } from "./message-markdown";

type Recorder = { recording: false } | { recording: true; path?: string; startedAt: number; stopping: boolean };

interface DesktopMeetings {
  start(): Promise<{ path: string }>;
  stop(): Promise<void>;
  state(): Promise<Recorder>;
  onState(cb: (state: Recorder) => void): void;
}

interface Line {
  seq: number;
  at: number;
  speaker: "me" | "others";
  text: string;
}

interface Note {
  app: string | null;
  startedAt: number;
  endedAt: number | null;
  brief: string | null;
  notes: string;
  transcript: Line[];
  flags: { at: number; text: string }[];
  writeup: string | null;
  writing: boolean;
}

const POLL_MS = 3_000;
const SAVE_MS = 800;

let enabled = false;
let flag: Promise<boolean> | null = null;
let recorder: Recorder = { recording: false };
let starting = false;
let browserHint = false;
let startError: string | null = null;
const listeners = new Set<() => void>();

function desktopMeetings(): DesktopMeetings | undefined {
  return (window as { qmDesktop?: { meetings?: DesktopMeetings } }).qmDesktop?.meetings;
}

function changed(): void {
  for (const listener of listeners) listener();
}

function follow(state: Recorder): void {
  recorder = state;
  changed();
}

export function meetingsReady(): Promise<boolean> {
  flag ??= api<{ enabled?: boolean }>("/api/meetings")
    .then((r) => {
      enabled = r.enabled === true;
      const desk = enabled ? desktopMeetings() : undefined;
      desk?.onState(follow);
      void desk?.state().then(follow);
      if (enabled) changed();
      return enabled;
    })
    .catch(() => false);
  return flag;
}

export function meetingOf(session: CoreSession): string | null {
  return enabled ? (session.meetingId ?? null) : null;
}

const sessionOf = (path: string): string => path.split("/").pop() ?? "";

export function meetingsSidebar(
  rows: TemplateResult[],
  open: (sessionId: string) => void,
  redraw: () => void,
): TemplateResult | typeof nothing {
  listeners.add(redraw);
  void meetingsReady();
  if (!enabled) return nothing;
  const desk = desktopMeetings();
  const current = recorder.recording ? recorder.path : undefined;
  const begin = async () => {
    startError = null;
    if (!desk) {
      browserHint = !browserHint;
      return changed();
    }
    if (current) return open(sessionOf(current));
    starting = true;
    changed();
    try {
      open(sessionOf((await desk.start()).path));
    } catch (error) {
      startError = (error instanceof Error ? error.message : String(error)).split("Error: ").pop() ?? null;
    } finally {
      starting = false;
      changed();
    }
  };
  let label = "New meeting";
  if (starting) label = "Starting…";
  else if (recorder.recording) label = "Recording";
  return html`<div class="meetings-group">
    <div class="recents-group pinned-head meetings-head">
      <span class="pinned-head-glyph">${icon(AudioLines, 11)}</span><span>Meetings</span>
      <button
        class="meetings-new ${recorder.recording ? "recording" : ""}"
        type="button"
        ?disabled=${starting}
        @click=${() => void begin()}
      >
        ${recorder.recording ? html`<span class="meeting-dot"></span>` : icon(Plus, 12)}${label}
      </button>
    </div>
    ${
      browserHint
        ? html`<p class="meetings-hint">
            Meetings record in the QM desktop app on your Mac.
            <a href=${QM_MAC_DOWNLOAD_URL} target="_blank" rel="noreferrer noopener">Get the Mac app</a>
          </p>`
        : nothing
    }
    ${startError ? html`<p class="meetings-hint" role="alert">${startError}</p>` : nothing}
    <div class="pinned-children">${rows}</div>
  </div>`;
}

const problem = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function transcriptView(note: Note): TemplateResult {
  const flags = [...note.flags];
  const rows: { key: string; tpl: TemplateResult }[] = [];
  const flush = (until: number) => {
    while (flags.length && flags[0]!.at <= until) {
      const flagged = flags.shift()!;
      rows.push({
        key: `flag:${flagged.at}`,
        tpl: html`<div class="meeting-flag"><span class="meeting-qm">QM</span>${markdown(flagged.text)}</div>`,
      });
    }
  };
  for (const line of note.transcript) {
    flush(line.at);
    rows.push({
      key: String(line.seq),
      tpl: html`<p class="meeting-line">
        <span class="meeting-who ${line.speaker}">${line.speaker === "me" ? "Me" : "Them"}</span>${line.text}
      </p>`,
    });
  }
  flush(Infinity);
  return html`${repeat(
    rows,
    (row) => row.key,
    (row) => row.tpl,
  )}`;
}

function status(n: Note): TemplateResult {
  const app = n.app ? ` · ${n.app}` : "";
  if (n.endedAt === null)
    return html`<span class="meeting-rec"><span class="meeting-dot"></span>Recording${app}</span>`;
  return html`<span>Ended · ${duration(n.endedAt - n.startedAt)}${app}</span>`;
}

export function mountMeetingNote(host: HTMLElement, title: string, sessionId: string, id: string): void {
  let note: Note | null = null;
  let failed: string | null = null;
  let notes: string | null = null;
  let saveTimer: number | undefined;
  let saveError: string | null = null;
  const save = async () => {
    window.clearTimeout(saveTimer);
    if (notes === null) return;
    try {
      await api(`/api/meetings/${encodeURIComponent(id)}/notes`, { method: "PUT", body: JSON.stringify({ notes }) });
      saveError = null;
    } catch (error) {
      saveError = problem(error);
    }
    draw();
  };
  const onNotes = (e: Event) => {
    notes = (e.target as HTMLTextAreaElement).value;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), SAVE_MS);
  };
  const ours = () => recorder.recording && sessionOf(recorder.path ?? "") === sessionId;
  const view = (): TemplateResult => {
    if (!note)
      return html`<div class="meeting-note">
        <p class="meeting-empty">${failed ? `Couldn't load this meeting: ${failed}` : "Loading…"}</p>
      </div>`;
    const n = note;
    const stopping = recorder.recording && recorder.stopping;
    const day = new Date(n.startedAt).toLocaleDateString([], { month: "short", day: "numeric" });
    let writeup: TemplateResult | typeof nothing = nothing;
    if (n.writeup)
      writeup = html`<section class="meeting-writeup">
        <div class="meeting-qm">QM notes</div>
        ${markdown(n.writeup)}
      </section>`;
    else if (n.writing) writeup = html`<p class="meeting-empty">QM is writing up the meeting…</p>`;
    return html`<div class="meeting-note">
      <article class="meeting-body">
        <h1 dir="auto">${title}</h1>
        <div class="meeting-meta">
          ${status(n)}<span>${day}, ${clock(n.startedAt)}</span>
          ${
            ours()
              ? html`<button
                  class="btn meeting-stop"
                  type="button"
                  ?disabled=${stopping}
                  @click=${() => void desktopMeetings()?.stop().then(load)}
                >
                  ${stopping ? "Stopping…" : "Stop recording"}
                </button>`
              : nothing
          }
        </div>
        <section class="meeting-brief">
          <b>QM brief</b
          >${n.brief ? markdown(n.brief) : html`<p class="meeting-empty">QM is looking up this meeting…</p>`}
        </section>
        <textarea
          class="meeting-mine"
          aria-label="Your notes"
          placeholder="Write notes… QM fills in the rest when the meeting ends."
          .value=${live(notes ?? n.notes)}
          @input=${onNotes}
          @blur=${() => void save()}
        ></textarea>
        ${saveError ? html`<p class="meeting-empty" role="alert">Couldn't save your notes (${saveError}). Keep typing to retry.</p>` : nothing}
        ${writeup}
      </article>
      <aside class="meeting-transcript" aria-label="Transcript">
        <header>Transcript</header>
        <div class="meeting-lines">
          ${n.transcript.length ? transcriptView(n) : html`<p class="meeting-empty">Nothing heard yet.</p>`}
        </div>
      </aside>
    </div>`;
  };
  const draw = () => {
    const panel = host.querySelector<HTMLElement>(".meeting-lines");
    const following = !panel || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 24;
    render(view(), host);
    const lines = host.querySelector<HTMLElement>(".meeting-lines");
    if (lines && following) lines.scrollTop = lines.scrollHeight;
  };
  const redraw = () => {
    if (host.isConnected) draw();
    else listeners.delete(redraw);
  };
  let pollTimer: number | undefined;
  const load = async () => {
    window.clearTimeout(pollTimer);
    if (!host.isConnected) return;
    try {
      const after = note?.transcript.at(-1)?.seq ?? -1;
      const next = await api<Note>(`/api/meetings/${encodeURIComponent(id)}?after=${after}`);
      note = { ...next, transcript: [...(note?.transcript ?? []), ...next.transcript] };
      failed = null;
    } catch (error) {
      failed = problem(error);
    }
    draw();
    if (!note || note.endedAt === null || note.writing) pollTimer = window.setTimeout(() => void load(), POLL_MS);
  };
  listeners.add(redraw);
  draw();
  void load();
}
