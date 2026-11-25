import { html, nothing, type TemplateResult } from "lit";
import { ArrowUpLeft, GitFork } from "lucide";
import { icon } from "./icons";
import { tip } from "./tooltip";

export interface SessionTopbarOpts {
  crumb: string | null;
  title: string;
  parent?: { title: string; onClick: () => void } | null;
  fork?: { title: string; onClick?: (() => void) | null } | null;
  persona?: TemplateResult | typeof nothing;
  onCrumb?: (() => void) | null;
  members?: TemplateResult | typeof nothing;
}

export function sessionTopbarTpl(o: SessionTopbarOpts): TemplateResult {
  const crumbTpl = ((): TemplateResult | typeof nothing => {
    if (!o.crumb) return nothing;
    if (!o.onCrumb) return html`<span class="session-crumb">${o.crumb}</span><span class="session-crumb-sep">/</span>`;
    return html`<button
        class="session-crumb as-link"
        type="button"
        ${tip(`Open the ${o.crumb} project`)}
        @click=${(e: Event) => {
          e.stopPropagation();
          o.onCrumb!();
        }}
      >
        ${o.crumb}</button
      ><span class="session-crumb-sep">/</span>`;
  })();
  const heading = html`
    ${crumbTpl} ${o.title ? html`<span class="session-title" dir="auto">${o.title}</span>` : nothing}
    ${
      o.fork
        ? html`<button
            class="session-fork-badge"
            type="button"
            ${tip(`Forked from ${o.fork.title}${o.fork.onClick ? ". Open the original" : ""}`)}
            ?disabled=${!o.fork.onClick}
            @click=${(e: Event) => {
              e.stopPropagation();
              o.fork?.onClick?.();
            }}
          >
            ${icon(GitFork, 12)}<span>fork</span>
          </button>`
        : nothing
    }
    ${o.persona ?? nothing}
  `;
  return html`
    <header class="chat-topbar session-topbar">
      ${
        o.parent
          ? html`<button
                class="session-parent-link"
                type="button"
                aria-label=${`Back to parent: ${o.parent.title}`}
                ${tip(`Back to ${o.parent.title}`)}
                @click=${o.parent.onClick}
              >
                ${icon(ArrowUpLeft, 15)}<span>${o.parent.title}</span>
              </button>
              <span class="session-crumb-sep" aria-hidden="true">/</span>`
          : nothing
      }
      <div class="session-heading">${heading}</div>
      ${o.members ?? nothing}
    </header>
  `;
}

export function openProjectPage(scopeId: string): void {
  void import("./contexts").then(({ openProjectDetail }) => openProjectDetail(scopeId));
}
