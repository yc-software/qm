import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { X } from "lucide";
import { icon } from "./icons";
import type { ApprovalDecision, PendingApproval } from "./core-bridge";
import {
  approvalBatch,
  approvalCall,
  approvalHeading,
  argView,
  realApprovalReason,
  wordDiff,
  type ApprovalCall,
  type BatchRow,
  type Segment,
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

const ROW_LIMIT = 6;

function segmentsView(segments: Segment[]): TemplateResult[] {
  return segments.map((seg) => (seg.changed ? html`<mark class="ac-diff">${seg.text}</mark>` : html`${seg.text}`));
}

function nodeView(node: ArgNode, segments?: Segment[]): TemplateResult {
  const body = segments ? segmentsView(segments) : node.kind === "text" || node.kind === "scalar" ? node.text : "";
  switch (node.kind) {
    case "scalar":
      return html`<span class="ac-value ${node.literal ? "literal" : ""} ${node.ident ? "ident" : ""}" dir="auto"
        >${body}</span
      >`;
    case "text":
      return html`<div class="ac-text" dir="auto" tabindex="0">${body}</div>`;
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

export function argsView(view: ArgView, diffs?: Map<string, Segment[]>): TemplateResult | typeof nothing {
  if (!view.fields.length && !view.empty.length) return nothing;
  return html`${
    view.fields.length
      ? html`<dl class="ac-fields">
          ${view.fields.map(
            (f) =>
              html`<div class="ac-row ac-k-${f.node.kind}">
                ${fieldLabel(f)}
                <dd>${nodeView(f.node, diffs?.get(f.full))}</dd>
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

export function approvalBody(a: PendingApproval): TemplateResult {
  const call = approvalCall(a);
  const reason = realApprovalReason(a.reason);
  return html`${call ? argsView(argView(call.args)) : commandBody(a)}
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

function closeButton(label: string, o: ApprovalCardOptions, onClick: () => void, cls: string): TemplateResult {
  return html`<button
    type="button"
    class=${cls}
    aria-label=${label}
    title=${label}
    ?disabled=${o.busy}
    @click=${onClick}
  >
    ${icon(X, 14)}
  </button>`;
}

function card(o: ApprovalCardOptions, cls: string, eyebrow: string, tool: ApprovalCall | null, body: unknown, n: number) {
  return html`<section class="ac-card ${cls} ${o.typing ? "declining" : ""}" role="group" aria-label="Approval">
    <header class="ac-head">
      <span class="ac-eyebrow">${eyebrow}</span>
      ${toolLine(tool)} ${closeButton(n > 1 ? "Decline all" : "Decline", o, o.declineAll, "ac-dismiss")}
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

function textOf(node: ArgNode): string | null {
  return node.kind === "text" || node.kind === "scalar" ? node.text : null;
}

function rowDiffs(rows: BatchRow[], index: number): Map<string, Segment[]> {
  const other = rows[index === 0 ? 1 : 0];
  const diffs = new Map<string, Segment[]>();
  if (!other) return diffs;
  for (const f of rows[index]!.view.fields) {
    const mine = textOf(f.node);
    const theirs = other.view.fields.find((g) => g.full === f.full);
    const ref = theirs ? textOf(theirs.node) : null;
    if (mine === null || ref === null || mine.split(/\s+/).length < 4) continue;
    const segments = wordDiff(mine, ref);
    if (segments.some((seg) => !seg.changed)) diffs.set(f.full, segments);
  }
  return diffs;
}

function snippet(view: ArgView): string {
  const texts = view.fields.map((f) => textOf(f.node)).filter((t): t is string => !!t);
  return texts.join(" · ").replace(/\s+/g, " ").slice(0, 240);
}

interface Row {
  approval: PendingApproval;
  heading: string;
  preview: string;
  body: () => TemplateResult;
}

function rowView(row: Row, i: number, o: ApprovalCardOptions): TemplateResult {
  return html`<li class="ac-item">
    <details>
      <summary>
        <span class="ac-index">${i + 1}</span>
        <span class="ac-item-title" dir="auto">${row.heading}</span>
        <span class="ac-preview" dir="auto">${row.preview}</span>
      </summary>
      <div class="ac-item-body">${row.body()}</div>
    </details>
    ${closeButton("Leave this one out", o, () => o.decide({ requestId: row.approval.requestId, approved: false }), "ac-drop")}
  </li>`;
}

function rowsView(rows: Row[], o: ApprovalCardOptions): TemplateResult {
  const keyed = (list: Row[], from: number) =>
    repeat(
      list,
      (r) => r.approval.requestId,
      (r, i) => rowView(r, from + i, o),
    );
  if (rows.length <= ROW_LIMIT) return html`<ol class="ac-items">${keyed(rows, 0)}</ol>`;
  const head = ROW_LIMIT - 1;
  return html`<ol class="ac-items">
    ${keyed(rows.slice(0, head), 0)}
    <li class="ac-more">
      <details>
        <summary>and ${rows.length - head} more</summary>
        <ol class="ac-items">${keyed(rows.slice(head), head)}</ol>
      </details>
    </li>
  </ol>`;
}

function batchCard(approvals: PendingApproval[], o: ApprovalCardOptions): TemplateResult {
  const batch = approvalBatch(approvals);
  const eyebrow = `${approvals.length} calls need your approval`;
  if (!batch) {
    const rows = approvals.map((a): Row => {
      const call = approvalCall(a);
      return {
        approval: a,
        heading: approvalHeading(a, call),
        preview: call ? snippet(argView(call.args)) : a.command,
        body: () => html`${call ? html`<div class="ac-item-tool">${toolLine(call)}</div>` : nothing}${approvalBody(a)}`,
      };
    });
    return card(o, "ac-batch", eyebrow, null, rowsView(rows, o), approvals.length);
  }
  const rows = batch.rows.map(
    (row, i): Row => ({
      approval: row.approval,
      heading: row.heading,
      preview: snippet(row.view),
      body: () => html`${argsView(row.view, rowDiffs(batch.rows, i))}`,
    }),
  );
  const shared = batch.shared;
  const scalars = { fields: shared.fields.filter((f) => f.node.kind === "scalar"), empty: [] };
  const rest = { fields: shared.fields.filter((f) => f.node.kind !== "scalar"), empty: shared.empty };
  return card(
    o,
    "ac-batch",
    eyebrow,
    batch.call,
    html`${
      shared.fields.length || shared.empty.length
        ? html`<div class="ac-shared">
            <span class="ac-caption">Same for each</span>
            ${inlineView(scalars)} ${argsView(rest)}
          </div>`
        : nothing
    }
    ${rowsView(rows, o)}`,
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
    <span class="ac-receipt-mark" aria-hidden="true"></span>
    <span class="ac-receipt-verdict">${r.verdict === "approved" ? "Approved" : "Declined"}</span>
    <span class="ac-receipt-text" dir="auto">${r.text}</span>
  </div>`;
}
