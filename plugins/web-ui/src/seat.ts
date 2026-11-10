import { html, nothing, render, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { keyed } from "lit/directives/keyed.js";
import { live } from "lit/directives/live.js";
import "./seat.css";
import { errMessage } from "../../chassis/src/errors";
import { api, ApiError } from "./core-bridge";
import {
  ageLabel,
  argsTemplate,
  buildMove,
  draftFromBlocks,
  messageViews,
  preview,
  systemTexts,
  withoutImageData,
  type MessageView,
  type MoveDraft,
  type RenderedBlock,
  type SeatBlock,
  type SeatStep,
  type SeatStepSummary,
  type SeatTool,
} from "./seat-request";

const SEAT_POLL_MS = 1500;
const FRESH_MS = 6000;
const LONG_TEXT = 600;

interface StepDerived {
  id: string;
  system: string[];
  messages: MessageView[];
  raw: string | null;
}

interface SeatView {
  host: HTMLElement;
  steps: SeatStepSummary[] | null;
  firstSeen: Map<string, number>;
  moved: Set<string>;
  off: string | null;
  listError: string | null;
  selected: SeatStep | null;
  derived: StepDerived | null;
  loading: string | null;
  draft: MoveDraft;
  draftModel: string | null;
  error: string | null;
  busy: "move" | "ask" | null;
  timer: ReturnType<typeof setTimeout> | null;
}

let current: SeatView | null = null;

const emptyDraft = (): MoveDraft => ({ text: "", calls: [] });

export function mountSeat(host: HTMLElement): void {
  if (current?.timer) clearTimeout(current.timer);
  current = {
    host,
    steps: null,
    firstSeen: new Map(),
    moved: new Set(),
    off: null,
    listError: null,
    selected: null,
    derived: null,
    loading: null,
    draft: emptyDraft(),
    draftModel: null,
    error: null,
    busy: null,
    timer: null,
  };
  draw(current);
  void poll(current);
}

function isLive(v: SeatView): boolean {
  return current === v && v.host.isConnected;
}

async function poll(v: SeatView): Promise<void> {
  if (!isLive(v)) return;
  if (!document.hidden) await refreshSteps(v);
  if (isLive(v)) v.timer = setTimeout(() => void poll(v), SEAT_POLL_MS);
}

async function refreshSteps(v: SeatView): Promise<void> {
  try {
    const { steps: all } = await api<{ steps: SeatStepSummary[] }>("/api/seat/steps");
    if (!isLive(v)) return;
    const steps = all.filter((s) => !v.moved.has(s.id));
    const now = Date.now();
    const initial = v.steps === null;
    for (const s of steps) if (!v.firstSeen.has(s.id)) v.firstSeen.set(s.id, initial ? 0 : now);
    v.steps = steps;
    v.off = null;
    v.listError = null;
  } catch (error) {
    if (!isLive(v)) return;
    if (error instanceof ApiError && error.status === 403) v.off = error.message;
    else v.listError = errMessage(error);
    v.steps ??= [];
  }
  ensureSelection(v);
  draw(v);
}

function ensureSelection(v: SeatView): void {
  const steps = v.steps ?? [];
  if (v.selected && !steps.some((s) => s.id === v.selected!.id)) clearSelection(v);
  if (!v.selected && !v.loading && steps[0]) void select(v, steps[0].id);
}

function clearSelection(v: SeatView): void {
  v.selected = null;
  v.derived = null;
  v.draft = emptyDraft();
  v.draftModel = null;
}

async function select(v: SeatView, id: string): Promise<void> {
  if (v.selected?.id === id || v.loading === id) return;
  v.loading = id;
  draw(v);
  try {
    const { step } = await api<{ step: SeatStep }>(`/api/seat/steps/${encodeURIComponent(id)}`);
    if (!isLive(v) || v.loading !== id) return;
    clearSelection(v);
    v.selected = step;
    v.error = null;
    v.loading = null;
    drawAtEnd(v);
  } catch (error) {
    if (!isLive(v) || v.loading !== id) return;
    v.loading = null;
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
      v.steps = (v.steps ?? []).filter((s) => s.id !== id);
      ensureSelection(v);
    } else v.error = errMessage(error);
    draw(v);
  }
}

async function makeMove(v: SeatView): Promise<void> {
  const step = v.selected;
  if (!step || v.busy) return;
  const move = buildMove(v.draft, step.request.tools ?? []);
  if ("error" in move) {
    v.error = move.error;
    drawAtEnd(v);
    return;
  }
  v.busy = "move";
  v.error = null;
  draw(v);
  try {
    await api(`/api/seat/steps/${encodeURIComponent(step.id)}/move`, {
      method: "POST",
      body: JSON.stringify({ content: move.content }),
    });
    if (!isLive(v)) return;
    v.moved.add(step.id);
    v.steps = (v.steps ?? []).filter((s) => s.id !== step.id);
    if (v.selected?.id === step.id) clearSelection(v);
  } catch (error) {
    if (!isLive(v)) return;
    v.error = errMessage(error);
  }
  v.busy = null;
  ensureSelection(v);
  drawAtEnd(v);
}

async function askModel(v: SeatView): Promise<void> {
  const step = v.selected;
  if (!step || v.busy) return;
  v.busy = "ask";
  v.error = null;
  draw(v);
  try {
    const answer = await api<{ model: string; content: SeatBlock[] }>(
      `/api/seat/steps/${encodeURIComponent(step.id)}/ask`,
      { method: "POST", body: "{}" },
    );
    if (!isLive(v) || v.selected?.id !== step.id) return;
    v.draft = draftFromBlocks(answer.content);
    v.draftModel = answer.model;
  } catch (error) {
    if (!isLive(v)) return;
    v.error = errMessage(error);
  }
  v.busy = null;
  drawAtEnd(v);
}

function draw(v: SeatView): void {
  if (current !== v) return;
  render(page(v), v.host);
}

function drawAtEnd(v: SeatView): void {
  draw(v);
  v.host.scrollTop = v.host.scrollHeight;
}

function page(v: SeatView): TemplateResult {
  const steps = v.steps ?? [];
  return html`
    <div class="seat">
      <div class="seat-head">
        <h1 class="seat-title">Agent Seat</h1>
        ${steps.length ? html`<span class="seat-count">${steps.length} waiting</span>` : nothing}
      </div>
      ${v.listError ? html`<p class="seat-error" role="alert">Couldn't load steps: ${v.listError}</p>` : nothing}
      ${body(v, steps)}
    </div>
  `;
}

function body(v: SeatView, steps: SeatStepSummary[]): TemplateResult {
  if (v.off) return html`<p class="seat-empty">${v.off}</p>`;
  if (v.steps === null) return html`<p class="seat-empty">Loading…</p>`;
  if (!steps.length && !v.selected)
    return html`
      ${v.error ? html`<p class="seat-error" role="alert">${v.error}</p>` : nothing}
      <p class="seat-empty">
        Nothing to play yet. Pick “You (Agent Seat)” in the model picker of one of your own conversations and send a
        message. Each model call in that turn waits here for your move.
      </p>
    `;
  const now = Date.now();
  return html`
    <div class="seat-layout">
      <ol class="seat-steps" aria-label="Waiting steps">
        ${steps.map((s) => {
          const seen = v.firstSeen.get(s.id) ?? 0;
          const fresh = seen > 0 && now - seen < FRESH_MS;
          const active = v.selected?.id === s.id || v.loading === s.id;
          return html`
            <li>
              <button
                type="button"
                class="seat-step ${active ? "active" : ""} ${fresh ? "fresh" : ""}"
                aria-current=${active ? "true" : "false"}
                @click=${() => void select(v, s.id)}
              >
                <span class="seat-step-title">${s.sessionTitle?.trim() || "Untitled conversation"}</span>
                <span class="seat-step-age">${fresh ? "new · " : ""}${ageLabel(s.createdAt, now)}</span>
              </button>
            </li>
          `;
        })}
      </ol>
      <div class="seat-main">
        ${
          v.selected
            ? keyed(v.selected.id, stepView(v, v.selected))
            : html`<p class="seat-empty">${v.loading ? "Loading…" : ""}</p>`
        }
      </div>
    </div>
  `;
}

function fold(label: string, peek: string, open: boolean, content: unknown, cls = ""): TemplateResult {
  return html`
    <details class="seat-fold ${cls}" ?open=${open}>
      <summary>
        <span class="seat-label">${label}</span>${peek ? html` <span class="seat-peek">${peek}</span>` : nothing}
      </summary>
      <div class="seat-fold-body">${content}</div>
    </details>
  `;
}

function block(b: RenderedBlock): TemplateResult {
  return html`
    <div class="seat-block">
      ${b.label === "text" ? nothing : html`<div class="seat-block-label">${b.label}</div>`}
      <pre class=${b.code ? "seat-text seat-code" : "seat-text"}>${b.body}</pre>
    </div>
  `;
}

function derive(v: SeatView, step: SeatStep): StepDerived {
  if (v.derived?.id !== step.id)
    v.derived = { id: step.id, system: systemTexts(step.request), messages: messageViews(step.request), raw: null };
  return v.derived;
}

function toggleRaw(v: SeatView, step: SeatStep, e: Event): void {
  const d = derive(v, step);
  if (!(e.currentTarget as HTMLDetailsElement).open || d.raw !== null) return;
  d.raw = JSON.stringify(withoutImageData(step.request), null, 2);
  draw(v);
}

function requestView(v: SeatView, step: SeatStep, d: StepDerived): TemplateResult {
  const r = step.request;
  const tools = r.tools ?? [];
  const meta = [r.model, r.max_tokens !== undefined ? `max_tokens ${String(r.max_tokens)}` : ""].filter(Boolean);
  return html`
    <section class="seat-request" aria-label="Request">
      <div class="seat-meta">${meta.join(" · ")}</div>
      ${d.system.map((text, i) =>
        fold(
          d.system.length > 1 ? `system ${i + 1}` : "system",
          preview(text),
          text.length <= LONG_TEXT,
          html`<pre class="seat-text">${text}</pre>`,
        ),
      )}
      ${
        tools.length
          ? fold(
              `tools (${tools.length})`,
              tools.map((t) => t.name).join(", "),
              false,
              tools.map((t) => toolView(t)),
            )
          : nothing
      }
      ${fold(
        `messages (${d.messages.length})`,
        "",
        true,
        d.messages.map((m) => fold(m.role, m.preview, m.open, m.blocks.map(block), `seat-message seat-role-${m.role}`)),
        "seat-messages",
      )}
      <details class="seat-fold" @toggle=${(e: Event) => toggleRaw(v, step, e)}>
        <summary><span class="seat-label">raw request</span></summary>
        <div class="seat-fold-body">
          ${d.raw === null ? nothing : html`<pre class="seat-text seat-code">${d.raw}</pre>`}
        </div>
      </details>
    </section>
  `;
}

function stepView(v: SeatView, step: SeatStep): TemplateResult {
  const d = derive(v, step);
  return html`
    <div class="seat-step-head">
      <span class="seat-step-name">${step.sessionTitle?.trim() || "Untitled conversation"}</span>
    </div>
    ${guard([step.id, d.raw], () => requestView(v, step, d))} ${composer(v, step.request.tools ?? [])}
  `;
}

function toolView(t: SeatTool): TemplateResult {
  return fold(
    t.name,
    preview(t.description ?? ""),
    false,
    html`
      ${t.description ? html`<pre class="seat-text">${t.description}</pre>` : nothing}
      <div class="seat-block-label">input_schema</div>
      <pre class="seat-text seat-code">${JSON.stringify(t.input_schema ?? {}, null, 2)}</pre>
    `,
  );
}

function rows(text: string, min: number): number {
  return Math.min(18, Math.max(min, text.split("\n").length));
}

function onKey(v: SeatView, e: KeyboardEvent): void {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  void makeMove(v);
}

function composer(v: SeatView, tools: SeatTool[]): TemplateResult {
  const d = v.draft;
  const update = (next: Partial<MoveDraft>) => {
    v.draft = { ...v.draft, ...next };
    draw(v);
  };
  const setCall = (i: number, next: Partial<MoveDraft["calls"][number]>) =>
    update({ calls: d.calls.map((c, j) => (j === i ? { ...c, ...next } : c)) });
  const pickTool = (i: number, name: string) => {
    const call = d.calls[i]!;
    const untouched = !call.args.trim() || call.args === argsTemplate(tools, call.name);
    setCall(i, { name, ...(untouched ? { args: argsTemplate(tools, name) } : {}) });
  };
  return html`
    <form
      class="seat-move"
      aria-label="Your move"
      @submit=${(e: Event) => {
        e.preventDefault();
        void makeMove(v);
      }}
    >
      <div class="seat-move-head">
        <span class="seat-prompt">&gt;</span> your move
        ${v.draftModel ? html`<span class="seat-draft-note">draft from ${v.draftModel}, edit freely</span>` : nothing}
      </div>
      <textarea
        class="seat-input"
        aria-label="Reply text"
        placeholder="Reply text (optional with tool calls)"
        spellcheck="false"
        rows=${rows(d.text, 3)}
        .value=${live(d.text)}
        @input=${(e: Event) => update({ text: (e.target as HTMLTextAreaElement).value })}
        @keydown=${(e: KeyboardEvent) => onKey(v, e)}
      ></textarea>
      ${d.calls.map(
        (call, i) => html`
          <div class="seat-call">
            <div class="seat-call-head">
              <span class="seat-label">tool_use</span>
              <select
                aria-label="Tool"
                .value=${live(call.name)}
                @change=${(e: Event) => pickTool(i, (e.target as HTMLSelectElement).value)}
              >
                <option value="" ?selected=${!call.name}>Pick a tool</option>
                ${tools.map((t) => html`<option value=${t.name} ?selected=${t.name === call.name}>${t.name}</option>`)}
                ${
                  call.name && !tools.some((t) => t.name === call.name)
                    ? html`<option value=${call.name} selected>${call.name}</option>`
                    : nothing
                }
              </select>
              <button
                type="button"
                class="btn compact"
                @click=${() => update({ calls: d.calls.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
            <textarea
              class="seat-input seat-code"
              aria-label="Arguments (JSON)"
              spellcheck="false"
              rows=${rows(call.args, 2)}
              .value=${live(call.args)}
              @input=${(e: Event) => setCall(i, { args: (e.target as HTMLTextAreaElement).value })}
              @keydown=${(e: KeyboardEvent) => onKey(v, e)}
            ></textarea>
          </div>
        `,
      )}
      ${v.error ? html`<p class="seat-error" role="alert">${v.error}</p>` : nothing}
      <div class="seat-actions">
        <button
          type="button"
          class="btn"
          ?disabled=${!tools.length}
          @click=${() => update({ calls: [...d.calls, { name: "", args: "{}" }] })}
        >
          Add tool call
        </button>
        <button type="button" class="btn" ?disabled=${v.busy !== null} @click=${() => void askModel(v)}>
          ${v.busy === "ask" ? "Asking…" : "Ask model"}
        </button>
        <button type="submit" class="btn primary" ?disabled=${v.busy !== null}>
          ${v.busy === "move" ? "Sending…" : "Make move"}
        </button>
      </div>
    </form>
  `;
}
