import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { Check, ChevronRight, Clock3, X } from "lucide";
import { animateDetailsToggle } from "./details-motion";
import { icon } from "./icons";
import type { ApprovalDecision, PendingApproval } from "./core-bridge";
import {
  approvalBatch,
  approvalCall,
  approvalHeading,
  argView,
  type ApprovalCall,
  type ArgField,
  type ArgNode,
  type ArgView,
} from "./approval-call";

export interface ApprovalCardOptions {
  docked: boolean;
  typing: boolean;
  busy: boolean;
  decide: (decision: ApprovalDecision) => void;
  approveAll: () => void;
  declineAll: () => void;
}

function nodeView(node: ArgNode): TemplateResult {
  switch (node.kind) {
    case "scalar":
      return html`<span class="ac-value ${node.literal ? "literal" : ""}" dir="auto">${node.text}</span>`;
    case "text":
      return html`<div class="ac-text" dir="auto" tabindex="0">${node.text}</div>`;
    case "record":
      return node.inline
        ? html`<div class="ac-inline-record">${inlineView(node.view)}</div>`
        : html`<div class="ac-record">${argsView(node.view)}</div>`;
    case "list":
      return html`<ol class="ac-list">
        ${node.items.map((item) => html`<li>${nodeView(item)}</li>`)}
      </ol>`;
  }
}

function fieldLabel(f: ArgField): TemplateResult {
  return html`<dt title=${f.full}>
    ${f.path.map((seg) => html`<span class="ac-path">${seg}</span>`)}<span>${f.label}</span>
  </dt>`;
}

function argsView(view: ArgView): TemplateResult | typeof nothing {
  if (!view.fields.length && !view.empty.length) return nothing;
  return html`${
    view.fields.length
      ? html`<dl class="ac-fields">
          ${view.fields.map(
            (f) =>
              html`<div class="ac-row ac-k-${f.node.kind}">
                ${fieldLabel(f)}
                <dd>${nodeView(f.node)}</dd>
              </div>`,
          )}
        </dl>`
      : nothing
  }
  ${view.empty.length ? html`<div class="ac-empty">Sent empty: ${view.empty.join(", ")}</div>` : nothing}`;
}

function inlineView(view: ArgView): TemplateResult {
  return html`${view.fields.map(
    (f) =>
      html`<span class="ac-pair"
        ><span class="ac-pair-key" title=${f.full}>${[...f.path, f.label].join(" ")}</span> ${nodeView(f.node)}</span
      >`,
  )}`;
}

function toolLine(call: ApprovalCall | null): TemplateResult | typeof nothing {
  if (!call) return nothing;
  return html`<span class="ac-tool" title=${call.via ? `${call.via} / ${call.tool}` : call.tool}
    >${call.via ? html`${call.via}<span class="ac-sep">/</span>` : nothing}${call.tool}</span
  >`;
}

function commandBody(a: PendingApproval): TemplateResult {
  const showMatch = a.matched && !a.command.includes(a.matched);
  return html`<pre class="ac-command">${a.command}</pre>
    ${showMatch ? html`<div class="ac-note">Matched <code>${a.matched}</code></div>` : nothing}`;
}

function approvalBody(a: PendingApproval): TemplateResult {
  const call = approvalCall(a);
  if (call) return html`${argsView(argView(call.args))}`;
  const reason = a.reason;
  return html`${commandBody(a)}
  ${reason ? html`<div class="ac-note">${reason.charAt(0).toUpperCase() + reason.slice(1)}.</div>` : nothing}`;
}

function scopeLinks(a: PendingApproval, o: ApprovalCardOptions): TemplateResult | typeof nothing {
  const modes = (["session", "always"] as const).filter((m) => a.grantModes?.[m] !== false);
  if (!modes.length) return nothing;
  return html`<div class="ac-scopes">
    ${modes.map(
      (scope) =>
        html`<button
          type="button"
          ?disabled=${o.busy}
          @click=${() => o.decide({ requestId: a.requestId, approved: true, scope })}
        >
          ${scope === "session" ? "Allow for this session" : "Always allow"}
        </button>`,
    )}
  </div>`;
}

function footer(count: number, o: ApprovalCardOptions): TemplateResult | typeof nothing {
  if (o.docked) return nothing;
  return html`<div class="ac-actions">
    <button type="button" class="ac-link" ?disabled=${o.busy} @click=${o.declineAll}>Decline</button>
    <button type="button" class="ac-approve" ?disabled=${o.busy} @click=${o.approveAll}>
      ${count > 1 ? `Approve all ${count}` : "Approve"}
    </button>
  </div>`;
}

function card(
  o: ApprovalCardOptions,
  cls: string,
  eyebrow: string,
  tool: ApprovalCall | null,
  body: unknown,
  n: number,
) {
  return html`<section class="ac-card ${cls} ${o.typing ? "declining" : ""}" role="group" aria-label="Approval">
    <header class="ac-head">
      <span class="ac-eyebrow">${eyebrow}</span>
      ${toolLine(tool)}
      <button type="button" class="ac-dismiss" ?disabled=${o.busy} @click=${o.declineAll}>
        ${n > 1 ? "Decline all" : "Decline"}
      </button>
    </header>
    ${body} ${footer(n, o)}
  </section>`;
}

function singleCard(a: PendingApproval, o: ApprovalCardOptions): TemplateResult {
  const call = approvalCall(a);
  return card(
    o,
    "",
    "Needs your approval",
    call,
    html`<h3 class="ac-title" dir="auto">${approvalHeading(a, call)}</h3>
      <div class="ac-body">${approvalBody(a)}</div>
      ${scopeLinks(a, o)}`,
    1,
  );
}

function previewOf(view: ArgView): string {
  const texts = view.fields.flatMap((f) => (f.node.kind === "text" ? [f.node.text] : []));
  const scalars = view.fields.flatMap((f) => (f.node.kind === "scalar" && !f.node.literal ? [f.node.text] : []));
  return (texts.length ? texts : scalars).join(" · ");
}

interface Row {
  approval: PendingApproval;
  heading: string;
  preview: string;
  tool?: string;
}

function dropButton(row: Row, o: ApprovalCardOptions): TemplateResult {
  const decline = () => o.decide({ requestId: row.approval.requestId, approved: false });
  return html`<button
    type="button"
    class="ac-drop"
    aria-label="Leave this one out"
    title="Leave this one out"
    ?disabled=${o.busy}
    @click=${decline}
  >
    ${icon(X, 14)}
  </button>`;
}

function rowView(row: Row, i: number, o: ApprovalCardOptions, titled: boolean): TemplateResult {
  return html`<li class="ac-item ${titled ? "" : "ac-untitled"}">
    <details>
      <summary>
        <span class="ac-index">${i + 1}</span>${icon(ChevronRight, 14)}
        <span class="ac-summary">
          ${
            titled
              ? html`<span class="ac-summary-top"
                  ><span class="ac-item-title" dir="auto">${row.heading}</span
                  >${row.tool ? html`<span class="ac-tool">${row.tool}</span>` : nothing}</span
                >`
              : nothing
          }
          <span class="ac-preview" dir="auto">${row.preview}</span>
        </span>
      </summary>
      <div class="ac-item-body">${approvalBody(row.approval)}</div>
    </details>
    ${dropButton(row, o)}
  </li>`;
}

function rowsView(rows: Row[], o: ApprovalCardOptions): TemplateResult {
  const titled = new Set(rows.map((r) => r.heading)).size > 1 || rows.some((r) => !r.preview);
  return html`<ol class="ac-items">
    ${repeat(
      rows,
      (r) => r.approval.requestId,
      (r, i) => rowView(r, i, o, titled),
    )}
  </ol>`;
}

function batchCard(approvals: PendingApproval[], o: ApprovalCardOptions): TemplateResult {
  const batch = approvalBatch(approvals);
  const rows = approvals.map((a, i): Row => {
    const call = approvalCall(a);
    const own = batch ? previewOf(batch.differing[i]!) : "";
    return {
      approval: a,
      heading: approvalHeading(a, call),
      preview: own || (call ? previewOf(argView(call.args)) : a.command),
      ...(batch || !call ? {} : { tool: call.tool }),
    };
  });
  const purpose = approvals[0]!.purpose?.trim();
  const common = purpose && rows.every((r) => r.heading === purpose) ? purpose : null;
  return card(
    o,
    "ac-batch",
    `${approvals.length} calls need your approval`,
    batch?.call ?? null,
    html`${common ? html`<h3 class="ac-title" dir="auto">${common}</h3>` : nothing}${rowsView(rows, o)}`,
    approvals.length,
  );
}

export function approvalCard(approvals: PendingApproval[], o: ApprovalCardOptions): TemplateResult {
  return approvals.length === 1 ? singleCard(approvals[0]!, o) : batchCard(approvals, o);
}

export interface ApprovalReceipt {
  key: number;
  verdict: "approved" | "declined";
  text: string;
}

export function approvalReceipt(r: ApprovalReceipt): TemplateResult {
  return html`<div class="ac-receipt" data-verdict=${r.verdict} role="status">
    <span class="ac-receipt-mark" aria-hidden="true">${r.verdict === "approved" ? icon(Check, 10) : nothing}</span>
    <span class="ac-receipt-verdict">${r.verdict === "approved" ? "Approved" : "Declined"}</span>
    <span class="ac-receipt-text" dir="auto">${r.text}</span>
  </div>`;
}

export interface ApprovalRecord {
  approved: boolean;
  command: string;
  requestId?: string;
  scope?: string;
  declined?: string;
  purpose?: string;
  summary?: string;
  call?: { tool: string; input: Record<string, unknown> };
}

const APPROVED_LABEL: Record<string, string> = {
  once: "Approved",
  session: "Approved for this session",
  always: "Always approved",
};

export function approvalRecord(d: ApprovalRecord): TemplateResult {
  const a: PendingApproval = {
    requestId: d.requestId ?? "",
    command: d.command,
    ...(d.purpose ? { purpose: d.purpose } : {}),
    ...(d.summary ? { summary: d.summary } : {}),
    ...(d.call ? { call: d.call } : {}),
  };
  const call = approvalCall(a);
  const expired = d.declined === "expired";
  let verdict = expired ? "Expired" : "Declined";
  if (d.approved) verdict = APPROVED_LABEL[d.scope ?? "once"] ?? "Approved";
  const what = call || a.purpose ? approvalHeading(a, call) : d.command;
  let mark = X;
  if (d.approved) mark = Check;
  else if (expired) mark = Clock3;
  return html`<details class="tool-row tool-expandable approval-record ${d.approved ? "approved" : ""}">
    <summary class="tool-summary" @click=${animateDetailsToggle}>
      <span class="tool-icon">${icon(mark, 14)}</span>
      <span class="tool-label" title=${`${verdict}: ${what}`}
        >${verdict} <span class="tool-detail" dir="auto">${what}</span></span
      >
      <span class="activity-chevron">${icon(ChevronRight, 14)}</span>
    </summary>
    <div class="tool-disclosure approval-record-detail">${approvalBody(a)}</div>
  </details>`;
}
