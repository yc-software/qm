import { html, nothing, render, type TemplateResult } from "lit";
import { CheckCircle2, CornerUpLeft, Pause, Play, Zap } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { appState, can } from "./shell";

interface LoopView {
  id: string;
  name: string;
  purpose?: string;
  playbook: string;
  playbookVersion: number;
  successCondition: string;
  shipActions: Array<{ action: string; gate: "auto" | "hold" }>;
  state: "enabled" | "paused" | "quarantined" | "archived";
  health: "healthy" | "degraded" | "failing" | "quarantined";
  healthReason?: string;
  owner: string;
  cronId?: string;
  lastFiredAt?: number;
  consecutiveFailedFires?: number;
}

interface LoopItemView {
  id: string;
  sourceKey: string;
  sourceSummary?: string;
  status: string;
  attempts: number;
  parkedReason?: string;
  guidance?: string;
  updatedAt: number;
}

interface LoopOutputView {
  id: string;
  itemId: string;
  shipAction: string;
  label?: string;
  externalRef?: string;
  title: string;
  summary?: string;
  state: "ready" | "unconfirmed" | "shipped" | "returned" | "expired";
  decidedBy?: string;
  decisionNote?: string;
  createdAt: number;
}

interface LoopDetail {
  loop: LoopView;
  items: LoopItemView[];
  outputs: LoopOutputView[];
  vitals: { queue: { queued: number; inProgress: number }; openOutputs: number };
}

let loopList: LoopView[] = [];
let loopsHost: HTMLElement | null = null;
let loopsLoading = false;
let loopsNotice = "";
let activeLoopId: string | null = null;
let activeDetail: LoopDetail | null = null;
let loopBusy = false;
let playbookDraft: string | null = null;
let returnDrafts = new Map<string, string>();

export function resetActiveLoop(): void {
  activeLoopId = null;
  activeDetail = null;
  playbookDraft = null;
  returnDrafts = new Map();
}

function healthBadge(loop: LoopView): TemplateResult {
  const label = loop.state === "enabled" ? loop.health : loop.state;
  return html`<span class="loop-health loop-health-${label}" title=${loop.healthReason ?? ""}>${label}</span>`;
}

function ago(ts?: number): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function refreshLoops(): Promise<void> {
  loopsLoading = true;
  paint();
  try {
    const r = await api<{ loops: LoopView[] }>("/api/loops");
    loopList = r.loops ?? [];
    loopsNotice = "";
  } catch (e) {
    loopsNotice = errMessage(e);
  } finally {
    loopsLoading = false;
    paint();
  }
}

async function refreshDetail(id: string): Promise<void> {
  try {
    activeDetail = await api<LoopDetail>(`/api/loops/${encodeURIComponent(id)}`);
    loopsNotice = "";
  } catch (e) {
    loopsNotice = errMessage(e);
  }
  paint();
}

async function mutate(fn: () => Promise<unknown>): Promise<void> {
  if (loopBusy) return;
  loopBusy = true;
  paint();
  try {
    await fn();
    loopsNotice = "";
  } catch (e) {
    loopsNotice = errMessage(e);
  } finally {
    loopBusy = false;
    if (activeLoopId) await refreshDetail(activeLoopId);
    else await refreshLoops();
  }
}

function openLoop(id: string): void {
  activeLoopId = id;
  activeDetail = null;
  playbookDraft = null;
  void refreshDetail(id);
  paint();
}

function setState(loop: LoopView, state: LoopView["state"]): void {
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ state }) }),
  );
}

function fireNow(loop: LoopView): void {
  void mutate(() => api(`/api/loops/${encodeURIComponent(loop.id)}/fire`, { method: "POST" }));
}

function setAutopilot(loop: LoopView, enabled: boolean): void {
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}/autopilot`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  );
}

function decide(loop: LoopView, output: LoopOutputView, decision: "ship" | "return"): void {
  const note = returnDrafts.get(output.id)?.trim();
  if (decision === "return" && !note) {
    loopsNotice = "a return needs a note for the next attempt";
    paint();
    return;
  }
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}/outputs/${encodeURIComponent(output.id)}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    }),
  );
  returnDrafts.delete(output.id);
}

function savePlaybook(loop: LoopView): void {
  const draft = playbookDraft?.trim();
  if (!draft || draft === loop.playbook) {
    playbookDraft = null;
    paint();
    return;
  }
  void mutate(() =>
    api(`/api/loops/${encodeURIComponent(loop.id)}`, { method: "PATCH", body: JSON.stringify({ playbook: draft }) }),
  );
  playbookDraft = null;
}

function reviewRow(loop: LoopView, output: LoopOutputView, shipLabel = "Ship"): TemplateResult {
  const externalUrl = output.externalRef && /^https?:\/\//i.test(output.externalRef) ? output.externalRef : undefined;
  return html`
    <div class="loop-output">
      <div class="loop-output-main">
        <span class="loop-output-action">${output.shipAction}${output.label ? html` · ${output.label}` : nothing}</span>
        <span class="loop-output-title">
          ${
            externalUrl
              ? html`<a href=${externalUrl} target="_blank" rel="noopener noreferrer">${output.title}</a>`
              : output.title
          }
        </span>
        ${output.summary ? html`<span class="loop-output-summary">${output.summary}</span>` : nothing}
      </div>
      <div class="loop-output-decide">
        <input
          type="text"
          placeholder="return note…"
          .value=${returnDrafts.get(output.id) ?? ""}
          @input=${(e: Event) => returnDrafts.set(output.id, (e.target as HTMLInputElement).value)}
        />
        <button class="btn" type="button" ?disabled=${loopBusy} @click=${() => decide(loop, output, "return")}>
          ${icon(CornerUpLeft, 14)}<span>Return</span>
        </button>
        <button class="btn primary" type="button" ?disabled=${loopBusy} @click=${() => decide(loop, output, "ship")}>
          ${icon(CheckCircle2, 14)}<span>${shipLabel}</span>
        </button>
      </div>
    </div>
  `;
}

function itemRow(item: LoopItemView): TemplateResult {
  return html`
    <div class="loop-item">
      <span class="loop-item-status loop-item-${item.status}">${item.status}</span>
      <span class="loop-item-key">${item.sourceKey}</span>
      <span class="loop-item-summary">${item.sourceSummary ?? ""}</span>
      <span class="loop-item-meta">
        ${item.attempts > 0 ? `${item.attempts} attempt${item.attempts === 1 ? "" : "s"}` : ""}
        ${item.parkedReason ? html` · <span title=${item.parkedReason}>parked</span>` : nothing}
      </span>
    </div>
  `;
}

function detailTpl(detail: LoopDetail): TemplateResult {
  const { loop, items, outputs } = detail;
  const autopilot = loop.shipActions.length > 0 && loop.shipActions.every((policy) => policy.gate === "auto");
  const ready = outputs.filter((o) => o.state === "ready");
  const unconfirmed = outputs.filter((o) => o.state === "unconfirmed");
  const decided = outputs.filter((o) => o.state !== "ready" && o.state !== "unconfirmed");
  return html`
    ${listBackLink("Loops", () => {
      resetActiveLoop();
      paint();
      void refreshLoops();
    })}
    <div class="list-page-head">
      <h1 class="pane-title">${loop.name}</h1>
      <div class="list-page-actions">
        ${healthBadge(loop)}
        <button class="btn" type="button" ?disabled=${loopBusy} @click=${() => fireNow(loop)}>
          ${icon(Zap, 14)}<span>Fire now</span>
        </button>
        ${
          loop.state === "enabled"
            ? html`<button class="btn" type="button" ?disabled=${loopBusy} @click=${() => setState(loop, "paused")}>
                ${icon(Pause, 14)}<span>Pause</span>
              </button>`
            : html`<button
                class="btn primary"
                type="button"
                ?disabled=${loopBusy}
                @click=${() => setState(loop, "enabled")}
              >
                ${icon(Play, 14)}<span>${loop.state === "quarantined" ? "Clear quarantine" : "Resume"}</span>
              </button>`
        }
      </div>
    </div>
    ${loop.healthReason ? html`<p class="loop-health-reason">${loop.healthReason}</p>` : nothing}
    ${loopsNotice ? html`<p class="error-banner">${loopsNotice}</p>` : nothing}
    ${
      loop.shipActions.length
        ? html`<button
            class="loop-autopilot ${autopilot ? "on" : ""}"
            type="button"
            role="switch"
            aria-checked=${autopilot ? "true" : "false"}
            ?disabled=${loopBusy}
            @click=${() => setAutopilot(loop, !autopilot)}
          >
            <span class="loop-autopilot-copy">
              <span class="loop-autopilot-label">Autopilot</span>
              <span class="loop-autopilot-sublabel"
                >${autopilot ? "Shipping without review" : "Ships outputs without review"}</span
              >
            </span>
            <span class="loop-autopilot-switch"><span></span></span>
          </button>`
        : nothing
    }

    <h2 class="loop-section-title">
      Ready to ship ${ready.length ? html`<span class="loop-count">${ready.length}</span>` : nothing}
    </h2>
    ${ready.length ? ready.map((o) => reviewRow(loop, o)) : html`<p class="list-empty">Nothing waiting on you.</p>`}

    <h2 class="loop-section-title">
      Needs confirmation ${unconfirmed.length ? html`<span class="loop-count">${unconfirmed.length}</span>` : nothing}
    </h2>
    ${
      unconfirmed.length
        ? unconfirmed.map((o) => reviewRow(loop, o, "Confirm shipped"))
        : html`<p class="list-empty">Nothing needs confirmation.</p>`
    }

    <h2 class="loop-section-title">Playbook <span class="loop-count">v${loop.playbookVersion}</span></h2>
    <textarea
      class="loop-playbook"
      rows="10"
      .value=${playbookDraft ?? loop.playbook}
      @input=${(e: Event) => {
        playbookDraft = (e.target as HTMLTextAreaElement).value;
      }}
    ></textarea>
    <div class="loop-playbook-actions">
      <span class="loop-success-condition" title="success condition">Done when: ${loop.successCondition}</span>
      ${
        playbookDraft !== null && playbookDraft !== loop.playbook
          ? html`<button class="btn primary" type="button" ?disabled=${loopBusy} @click=${() => savePlaybook(loop)}>
              Save playbook
            </button>`
          : nothing
      }
    </div>

    <h2 class="loop-section-title">Work ledger</h2>
    ${items.length ? items.map(itemRow) : html`<p class="list-empty">No items yet. Fire the loop.</p>`}
    ${
      decided.length
        ? html`<h2 class="loop-section-title">Decided</h2>
            ${decided.map(
              (o) => html`
                <div class="loop-output loop-output-decided">
                  <span class="loop-output-state loop-output-${o.state}">${o.state}</span>
                  <span class="loop-output-title">${o.title}</span>
                  <span class="loop-output-meta"
                    >${o.decidedBy ?? ""} ${o.decisionNote ? `· ${o.decisionNote}` : ""}</span
                  >
                </div>
              `,
            )}`
        : nothing
    }
  `;
}

function loopRow(loop: LoopView): TemplateResult {
  return html`
    <button class="list-row loop-row" type="button" @click=${() => openLoop(loop.id)}>
      <span class="loop-row-name">${loop.name}</span>
      ${healthBadge(loop)}
      <span class="loop-row-meta">last fire ${ago(loop.lastFiredAt)}</span>
    </button>
  `;
}

function paint(): void {
  if (!loopsHost || appState.currentView !== "loops") return;
  if (activeLoopId) {
    render(activeDetail ? detailTpl(activeDetail) : html`<p class="list-empty">Loading…</p>`, loopsHost);
    return;
  }
  render(
    listPageTpl({
      title: "Loops",
      rows: loopList.map(loopRow),
      empty: loopsLoading
        ? "Loading…"
        : (loopsNotice ??
          "No loops yet. Ask the agent to set one up. The define-loop skill walks through it, shadow run first."),
    }),
    loopsHost,
  );
}

export async function renderLoopsPage(): Promise<void> {
  if (!can("loops")) return;
  if (!appState.mainEl) return;
  if (!loopsHost || loopsHost.parentElement !== appState.mainEl) {
    loopsHost = document.createElement("div");
    loopsHost.className = "pane loops-page";
    appState.mainEl.replaceChildren(loopsHost);
  }
  paint();
  await refreshLoops();
  if (activeLoopId) await refreshDetail(activeLoopId);
}
