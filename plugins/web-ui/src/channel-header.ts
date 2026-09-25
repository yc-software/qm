import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect } from "./ui";

interface HeaderPinWire {
  scopeId: string;
  on: boolean;
  configured?: boolean | null;
  default?: boolean;
}

export const channelHeaderState = {
  scope: null as string | null,
  loading: false,
  saving: false,
  on: false,
  configured: null as boolean | null,
  orgDefault: false,
  loaded: false,
  notice: "",
  noticeKind: "" as "" | "saved" | "error",
};

let loadSeq = 0;
let redraw: () => void = () => {};

export function channelHeaderApplies(scopeId: string): boolean {
  return scopeId.startsWith("channel:");
}

export function resetChannelHeader(): void {
  loadSeq += 1;
  channelHeaderState.scope = null;
  channelHeaderState.loading = false;
  channelHeaderState.saving = false;
  channelHeaderState.on = false;
  channelHeaderState.configured = null;
  channelHeaderState.orgDefault = false;
  channelHeaderState.loaded = false;
  channelHeaderState.notice = "";
  channelHeaderState.noticeKind = "";
}

export async function loadChannelHeader(scopeId: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (!channelHeaderApplies(scopeId) || channelHeaderState.scope === scopeId) return;
  resetChannelHeader();
  const seq = ++loadSeq;
  channelHeaderState.scope = scopeId;
  channelHeaderState.loading = true;
  try {
    const r = await api<HeaderPinWire>(`/api/channel-header-pin?scopeId=${encodeURIComponent(scopeId)}`);
    if (seq !== loadSeq) return;
    channelHeaderState.on = r.on;
    channelHeaderState.configured = r.configured ?? null;
    channelHeaderState.orgDefault = r.default ?? false;
    channelHeaderState.loaded = true;
  } catch (e) {
    if (seq !== loadSeq) return;
    channelHeaderState.notice = errMessage(e, "Couldn't load the pinned header setting.");
    channelHeaderState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      channelHeaderState.loading = false;
      redraw();
    }
  }
}

async function save(scope: string, on: boolean | null): Promise<void> {
  if (channelHeaderState.saving) return;
  const seq = loadSeq;
  channelHeaderState.saving = true;
  channelHeaderState.notice = "";
  channelHeaderState.noticeKind = "";
  redraw();
  try {
    const r = await api<HeaderPinWire>("/api/channel-header-pin", {
      method: "PUT",
      body: JSON.stringify({ scopeId: scope, on }),
    });
    if (seq !== loadSeq) return;
    channelHeaderState.on = r.on;
    channelHeaderState.configured = r.configured ?? null;
    channelHeaderState.notice = r.on ? "Header pinned in the channel." : "Pinned header removed.";
    channelHeaderState.noticeKind = "saved";
  } catch (e) {
    if (seq !== loadSeq) return;
    channelHeaderState.notice = errMessage(e, "Couldn't update the pinned header setting.");
    channelHeaderState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      channelHeaderState.saving = false;
      redraw();
    }
  }
}

function configuredSelectValue(configured: boolean | null): "default" | "on" | "off" {
  if (configured === null) return "default";
  return configured ? "on" : "off";
}

export function channelHeaderSection(scopeId: string): TemplateResult | typeof nothing {
  if (!channelHeaderApplies(scopeId) || channelHeaderState.scope !== scopeId) return nothing;
  if (channelHeaderState.loading)
    return html`<section class="context-panel channel-header" aria-labelledby="channel-header-title">
      <h2 class="context-panel-title" id="channel-header-title">Pinned header</h2>
      <div class="context-panel-loading">Loading…</div>
    </section>`;
  return html`
    <section class="context-panel channel-header" aria-labelledby="channel-header-title">
      <div class="context-panel-heading">
        <div>
          <h2 class="context-panel-title" id="channel-header-title">Pinned header</h2>
          <p class="context-panel-copy">A small pinned message in the Slack channel naming the model in use.</p>
        </div>
      </div>
      ${
        channelHeaderState.loaded
          ? fieldSelect({
              id: "channel-header-select",
              className: "channel-header-select",
              focusKey: "channel-header",
              describedBy: "channel-header-hint",
              ariaLabel: "Pinned Slack header for this channel",
              disabled: channelHeaderState.saving,
              value: configuredSelectValue(channelHeaderState.configured),
              onChange: (v) => void save(scopeId, v === "default" ? null : v === "on"),
              options: [
                html`<option value="default" ?selected=${channelHeaderState.configured === null}>
                  Default (${channelHeaderState.orgDefault ? "on" : "off"})
                </option>`,
                html`<option value="on" ?selected=${channelHeaderState.configured === true}>On</option>`,
                html`<option value="off" ?selected=${channelHeaderState.configured === false}>Off</option>`,
              ],
            })
          : nothing
      }
      <p class="channel-header-hint" id="channel-header-hint">
        Turning it on posts and pins the header; turning it off unpins and removes it. Default follows the org-wide
        setting. Model changes edit the pinned message in place.
      </p>
      ${
        channelHeaderState.notice
          ? html`<span class="context-model-status ${channelHeaderState.noticeKind}" aria-live="polite"
              >${channelHeaderState.notice}</span
            >`
          : nothing
      }
    </section>
  `;
}
