import { html, nothing, type TemplateResult } from "lit";
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

function toggleClamp(e: Event): void {
  const el = e.currentTarget as HTMLElement;
  if (el.scrollHeight > el.clientHeight + 2 || el.classList.contains("open")) el.classList.toggle("open");
}

function segmentsView(segments: Segment[]): TemplateResult[] {
  return segments.map((seg) => (seg.changed ? html`<mark class="ac-diff">${seg.text}</mark>` : html`${seg.text}`));
}

function nodeView(node: ArgNode, clamp: boolean, segments?: Segment[]): TemplateResult | typeof nothing {
  if (segments && (node.kind === "text" || node.kind === "scalar")) {
    const cls = node.kind === "text" ? `ac-text ${clamp ? "clamp" : ""}` : "ac-value";
    return html`<div class=${cls} dir="auto" @click=${clamp && node.kind === "text" ? toggleClamp : null}>
      <span class="ac-pre">${segmentsView(segments)}</span>
    </div>`;
  }
  switch (node.kind) {
    case "scalar":
      return html`<span class="ac-value ${node.literal ? "literal" : ""} ${node.ident ? "ident" : ""}" dir="auto"
        >${node.text}</span
      >`;
    case "text":
      return clamp
        ? html`<div class="ac-text clamp" dir="auto" title="Click to expand" @click=${toggleClamp}>
            <span class="ac-pre">${node.text}</span>
          </div>`
        : html`<div class="ac-text" dir="auto"><span class="ac-pre">${node.text}</span></div>`;
    case "record":
      return node.inline
        ? html`<div class="ac-inline-record">${inlineView(node.view)}</div>`
        : html`<div class="ac-record">${argsView(node.view, clamp)}</div>`;
    case "list":
      return html`<ol class="ac-list">
        ${node.items.map((item) => html`<li>${nodeView(item, clamp)}</li>`)}
      </ol>`;
  }
}

function fieldLabel(f: ArgField): TemplateResult {
  return html`<dt title=${f.full}>
    ${f.path.map((seg) => html`<span class="ac-path">${seg}</span>`)}<span>${f.label}</span>
  </dt>`;
}

export function argsView(
  view: ArgView,
  clamp = false,
  diffs?: Map<string, Segment[]>,
): TemplateResult | typeof nothing {
  if (!view.fields.length && !view.empty.length) return nothing;
  return html`${
    view.fields.length
      ? html`<dl class="ac-fields">
          ${view.fields.map(
            (f) =>
              html`<div class="ac-row ac-k-${f.node.kind}">
                ${fieldLabel(f)}
                <dd>${nodeView(f.node, clamp, diffs?.get(f.full))}</dd>
              </div>`,
          )}
        </dl>`
      : nothing
  }
  ${view.empty.length ? html`<div class="ac-empty">Sent empty: ${view.empty.join(", ")}</div>` : nothing}`;
}

function inlineView(view: ArgView): TemplateResult {
  return html`<div class="ac-inline">
    ${view.fields.map(
      (f) =>
        html`<span class="ac-pair"
          ><span class="ac-pair-key" title=${f.full}>${[...f.path, f.label].join(" ")}</span>
          ${nodeView(f.node, true)}</span
        >`,
    )}
  </div>`;
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

export function approvalBody(a: PendingApproval, clamp = false): TemplateResult {
  const call = approvalCall(a);
  const reason = realApprovalReason(a.reason);
  return html`${call ? argsView(argView(call.args), clamp) : commandBody(a)}
  ${reason ? html`<div class="ac-note">${reason.charAt(0).toUpperCase() + reason.slice(1)}.</div>` : nothing}`;
}

function scopeLinks(a: PendingApproval, o: ApprovalCardOptions): TemplateResult | typeof nothing {
  const session = a.grantModes?.session !== false;
  const always = a.grantModes?.always !== false;
  if (!session && !always) return nothing;
  return html`<div class="ac-scopes">
    ${
      session
        ? html`<button
            type="button"
            ?disabled=${o.busy}
            @click=${() => o.decide({ requestId: a.requestId, approved: true, scope: "session" })}
          >
            Allow for this session
          </button>`
        : nothing
    }
    ${
      always
        ? html`<button
            type="button"
            ?disabled=${o.busy}
            @click=${() => o.decide({ requestId: a.requestId, approved: true, scope: "always" })}
          >
            Always allow
          </button>`
        : nothing
    }
  </div>`;
}

function footer(count: number, o: ApprovalCardOptions): TemplateResult | typeof nothing {
  if (o.docked)
    return o.typing
      ? html`<div class="ac-foot ac-typing">
          Sending declines ${count > 1 ? `all ${count}` : "this"} and passes your note on.
        </div>`
      : nothing;
  return html`<div class="ac-foot ac-actions">
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

function singleCard(a: PendingApproval, o: ApprovalCardOptions): TemplateResult {
  const call = approvalCall(a);
  return html`<section class="ac-card" role="group" aria-label="Approval">
    <header class="ac-head">
      <span class="ac-eyebrow">Needs your approval</span>
      ${toolLine(call)} ${closeButton("Decline", o, o.declineAll, "ac-dismiss")}
    </header>
    <h3 class="ac-title" dir="auto">${approvalHeading(a, call)}</h3>
    <div class="ac-body">${approvalBody(a)}</div>
    ${scopeLinks(a, o)} ${footer(1, o)}
  </section>`;
}

function rowDrop(a: PendingApproval, o: ApprovalCardOptions): TemplateResult {
  return closeButton("Leave this one out", o, () => o.decide({ requestId: a.requestId, approved: false }), "ac-drop");
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

function batchCard(approvals: PendingApproval[], o: ApprovalCardOptions): TemplateResult {
  const batch = approvalBatch(approvals);
  const n = approvals.length;
  const head = html`<header class="ac-head">
    <span class="ac-eyebrow">${n} calls need your approval</span>
    ${batch ? toolLine(batch.call) : nothing} ${closeButton("Decline all", o, o.declineAll, "ac-dismiss")}
  </header>`;
  const sharedScalars = batch
    ? { fields: batch.shared.fields.filter((f) => f.node.kind === "scalar"), empty: [] }
    : null;
  const sharedRest = batch
    ? { fields: batch.shared.fields.filter((f) => f.node.kind !== "scalar"), empty: batch.shared.empty }
    : null;
  if (batch)
    return html`<section class="ac-card ac-batch" role="group" aria-label="Approvals">
      ${head}
      ${
        batch.shared.fields.length || batch.shared.empty.length
          ? html`<div class="ac-shared">
              <span class="ac-caption">Same for each</span>
              ${sharedScalars!.fields.length ? inlineView(sharedScalars!) : nothing} ${argsView(sharedRest!, true)}
            </div>`
          : nothing
      }
      <ol class="ac-items">
        ${batch.rows.map(
          (row, i) =>
            html`<li class="ac-item">
              <span class="ac-index">${i + 1}</span>
              <div class="ac-item-main">
                <div class="ac-item-title" dir="auto">${row.heading}</div>
                ${argsView(row.view, true, rowDiffs(batch.rows, i))}
              </div>
              ${rowDrop(row.approval, o)}
            </li>`,
        )}
      </ol>
      ${footer(n, o)}
    </section>`;
  return html`<section class="ac-card ac-batch ac-mixed" role="group" aria-label="Approvals">
    ${head}
    <ol class="ac-items">
      ${approvals.map((a, i) => {
        const call = approvalCall(a);
        return html`<li class="ac-item">
          <span class="ac-index">${i + 1}</span>
          <div class="ac-item-main">
            <div class="ac-item-title" dir="auto">${approvalHeading(a, call)}</div>
            ${call ? html`<div class="ac-item-tool">${toolLine(call)}</div>` : nothing}
            <div class="ac-body">${approvalBody(a, true)}</div>
          </div>
          ${rowDrop(a, o)}
        </li>`;
      })}
    </ol>
    ${footer(n, o)}
  </section>`;
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
