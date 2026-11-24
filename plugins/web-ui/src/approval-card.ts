import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ChevronDown, ChevronRight, X } from "lucide";
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

function textOf(node: ArgNode): string | null {
  return node.kind === "text" || node.kind === "scalar" ? node.text : null;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const WHEN = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;

function previewOf(view: ArgView): string {
  const scalars = view.fields.filter((f) => f.node.kind === "scalar" && !f.node.literal);
  const words = scalars.filter((f) => f.node.kind === "scalar" && !f.node.ident);
  return (words.length ? words : scalars)
    .map((f) => {
      const text = textOf(f.node)!;
      return ISO_TIME.test(text) ? new Date(text).toLocaleString(undefined, WHEN) : text;
    })
    .join(" · ");
}

type Template = { field: string; segments: Segment[] };

function templatesOf(rows: BatchRow[]): Template[] {
  const [first, second] = rows;
  if (!first || !second) return [];
  return first.view.fields.flatMap((f): Template[] => {
    const mine = textOf(f.node);
    const theirs = second.view.fields.find((g) => g.full === f.full);
    const ref = theirs ? textOf(theirs.node) : null;
    if (mine === null || ref === null || mine.split(/\s+/).length < 6) return [];
    const segments = wordDiff(mine, ref);
    const kept = segments.filter((s) => !s.changed).reduce((n, s) => n + s.text.trim().length, 0);
    return kept >= mine.replace(/\s+/g, "").length * 0.6 ? [{ field: f.full, segments }] : [];
  });
}

function slotsOf(rows: BatchRow[], i: number, field: string): string[] {
  const text = (r: BatchRow | undefined) => {
    const f = r?.view.fields.find((g) => g.full === field);
    return f ? (textOf(f.node) ?? "") : "";
  };
  return wordDiff(text(rows[i]), text(rows[i === 0 ? 1 : 0]))
    .filter((s) => s.changed)
    .map((s) => s.text);
}

interface Row {
  approval: PendingApproval;
  heading: string;
  line: TemplateResult;
  tool?: string;
  body?: () => TemplateResult;
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

function rowView(row: Row, i: number, o: ApprovalCardOptions, extra: boolean): TemplateResult {
  const index = html`<span class="ac-index">${i + 1}</span>`;
  const cls = `ac-item ${extra ? "ac-extra" : ""}`;
  if (!row.body)
    return html`<li class=${cls} title=${row.heading}>
      <div class="ac-flat">${index}<span class="ac-vals" dir="auto">${row.line}</span></div>
      ${dropButton(row, o)}
    </li>`;
  return html`<li class=${cls}>
    <details>
      <summary>
        ${index}${icon(ChevronRight, 14)}
        <span class="ac-summary">
          <span class="ac-summary-top"
            ><span class="ac-item-title" dir="auto">${row.heading}</span
            >${row.tool ? html`<span class="ac-tool">${row.tool}</span>` : nothing}</span
          >
          <span class="ac-preview" dir="auto">${row.line}</span>
        </span>
      </summary>
      <div class="ac-item-body">${row.body()}</div>
    </details>
    ${dropButton(row, o)}
  </li>`;
}

function showAll(e: Event): void {
  (e.currentTarget as HTMLElement).closest(".ac-items")?.classList.add("ac-all");
}

function rowsView(rows: Row[], o: ApprovalCardOptions): TemplateResult {
  const cut = rows.length > ROW_LIMIT ? ROW_LIMIT - 1 : rows.length;
  return html`<ol class="ac-items">
    ${repeat(
      rows,
      (r) => r.approval.requestId,
      (r, i) => rowView(r, i, o, i >= cut),
    )}
    ${
      cut < rows.length
        ? html`<li class="ac-more">
            <button type="button" @click=${showAll}>Show ${rows.length - cut} more ${icon(ChevronDown, 14)}</button>
          </li>`
        : nothing
    }
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
        tool: call?.tool,
        line: html`${call ? previewOf(argView(call.args)) : a.command}`,
        body: () => approvalBody(a),
      };
    });
    return card(o, "ac-batch", eyebrow, null, rowsView(rows, o), approvals.length);
  }
  const templates = templatesOf(batch.rows);
  const templated = new Set(templates.map((t) => t.field));
  const rows = batch.rows.map((row, i): Row => {
    const own = row.view.fields.filter((f) => !templated.has(f.full));
    const flat = own.every((f) => f.node.kind === "scalar");
    const view = { fields: own, empty: row.view.empty };
    return {
      approval: row.approval,
      heading: row.heading,
      line: html`${templates.map((t) =>
        slotsOf(batch.rows, i, t.field).map(
          (s) => html`<span class="ac-cell"><mark class="ac-diff">${s}</mark></span>`,
        ),
      )}${own.map((f) => nodeView(f.node))}`,
      ...(flat && templates.length ? {} : { body: () => html`${argsView(view)}` }),
    };
  });
  const shared = batch.shared;
  const scalars = { fields: shared.fields.filter((f) => f.node.kind === "scalar"), empty: [] };
  const rest = { fields: shared.fields.filter((f) => f.node.kind !== "scalar"), empty: shared.empty };
  const first = batch.rows[0]!.view;
  const message = { fields: first.fields.filter((f) => templated.has(f.full)), empty: [] };
  const diffs = new Map(templates.map((t) => [t.field, t.segments]));
  return card(
    o,
    "ac-batch",
    eyebrow,
    batch.call,
    html`${
      shared.fields.length || shared.empty.length || templates.length
        ? html`<div class="ac-shared">
            <span class="ac-caption"
              >${templates.length ? "Same for each, except the highlighted words" : "Same for each"}</span
            >
            ${inlineView(scalars)} ${argsView(rest)} ${argsView(message, diffs)}
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
