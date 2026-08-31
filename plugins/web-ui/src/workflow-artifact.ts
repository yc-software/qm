import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import {
  WORKFLOW_ARTIFACT_MIME,
  WorkflowArtifactRegistry,
  createDefaultWorkflowArtifactRegistry,
  validateWorkflowArtifactEnvelope,
  type WorkflowArtifactCard,
  type WorkflowArtifactEnvelope,
} from "./workflow-artifact-registry.ts";
import { UI_BASE } from "./deep-link.ts";

export const WORKFLOW_ARTIFACT_MAX_BYTES = 128 * 1024;
const GENERIC_FALLBACK = "This workflow artifact can’t be displayed.";

export function isWorkflowArtifactMime(value: string | undefined): boolean {
  return value === WORKFLOW_ARTIFACT_MIME;
}

function isWorkflowArtifactResponseMime(value: string | null): boolean {
  return value === WORKFLOW_ARTIFACT_MIME || value === `${WORKFLOW_ARTIFACT_MIME}; charset=utf-8`;
}

function fileContentRoute(value: string, baseUrl: string): URL {
  const url = new URL(value, baseUrl);
  const base = new URL(baseUrl);
  const routePrefix = `${UI_BASE}/api/files/`;
  const relative = url.pathname.startsWith(routePrefix) ? url.pathname.slice(routePrefix.length) : "";
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    !relative ||
    !/^[^/]+\/content$/.test(relative) ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid workflow artifact file route");
  }
  return url;
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > WORKFLOW_ARTIFACT_MAX_BYTES) {
      throw new Error("workflow artifact exceeds size limit");
    }
  }
  if (!response.body) throw new Error("workflow artifact has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > WORKFLOW_ARTIFACT_MAX_BYTES) {
        await reader.cancel();
        throw new Error("workflow artifact exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchWorkflowArtifact(
  artifactUrl: string,
  baseUrl: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<WorkflowArtifactEnvelope> {
  const url = fileContentRoute(artifactUrl, baseUrl);
  const response = await fetcher(url.href, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok || response.redirected || response.type === "opaqueredirect") {
    throw new Error("workflow artifact fetch failed");
  }
  if (response.url && response.url !== url.href) throw new Error("workflow artifact redirect refused");
  if (!isWorkflowArtifactResponseMime(response.headers.get("content-type"))) {
    throw new Error("workflow artifact MIME mismatch");
  }
  const bytes = await boundedResponseBytes(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid workflow artifact JSON");
  }
  return validateWorkflowArtifactEnvelope(parsed);
}

type ArtifactView =
  { kind: "loading" } | { kind: "card"; card: WorkflowArtifactCard } | { kind: "fallback"; text: string };

export class WorkflowArtifactElement extends LitElement {
  static properties = {
    artifactUrl: { attribute: "artifact-url" },
    originalHref: { attribute: "original-href" },
    registry: { attribute: false },
    view: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      flex: 1 1 100%;
      min-width: 0;
      max-width: 680px;
      color: var(--foreground);
      container-type: inline-size;
    }
    article {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--background);
    }
    header,
    section,
    footer {
      padding: 12px 14px;
    }
    section,
    footer {
      border-top: 1px solid var(--border);
    }
    h3,
    h4,
    p,
    dl,
    dd {
      margin: 0;
    }
    h3 {
      font-size: 15px;
      line-height: 1.35;
    }
    h4 {
      margin-bottom: 8px;
      color: var(--muted-foreground);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    p {
      margin-top: 6px;
      color: var(--muted-foreground);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .status {
      display: inline-flex;
      margin-top: 9px;
      padding: 3px 8px;
      border: 1px solid currentColor;
      border-radius: 999px;
      font-size: 11px;
      line-height: 1.2;
    }
    .status-info {
      color: var(--primary);
    }
    .status-success {
      color: var(--success, #18794e);
    }
    .status-warning {
      color: var(--warning, #946200);
    }
    .status-danger {
      color: var(--destructive);
    }
    dl {
      display: grid;
      grid-template-columns: minmax(100px, 0.35fr) minmax(0, 1fr);
      gap: 7px 12px;
      font-size: 13px;
      line-height: 1.4;
    }
    dt {
      color: var(--muted-foreground);
      overflow-wrap: anywhere;
    }
    dd {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    a {
      color: var(--primary);
      text-underline-offset: 2px;
      overflow-wrap: anywhere;
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: 13px;
    }
    footer {
      font-size: 12px;
    }
    @container (max-width: 480px) {
      header,
      section,
      footer {
        padding: 11px 12px;
      }
      dl {
        grid-template-columns: 1fr;
        gap: 3px;
      }
      dd + dt {
        margin-top: 6px;
      }
    }
  `;

  declare artifactUrl: string;
  declare originalHref: string;
  declare registry: WorkflowArtifactRegistry;
  declare private view: ArtifactView;
  private request: AbortController | null = null;
  private loadedUrl = "";
  private loadedRegistry: WorkflowArtifactRegistry | null = null;
  private generation = 0;

  constructor() {
    super();
    this.artifactUrl = "";
    this.originalHref = "";
    this.registry = createDefaultWorkflowArtifactRegistry();
    this.view = { kind: "loading" };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.startLoad();
  }

  override disconnectedCallback(): void {
    this.generation++;
    this.request?.abort();
    this.request = null;
    this.loadedUrl = "";
    this.loadedRegistry = null;
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("artifactUrl") || changed.has("registry")) this.startLoad();
  }

  private startLoad(): void {
    if (!this.isConnected || !this.artifactUrl) return;
    if (this.loadedUrl === this.artifactUrl && this.loadedRegistry === this.registry) return;
    this.request?.abort();
    const request = new AbortController();
    const generation = ++this.generation;
    this.request = request;
    this.loadedUrl = this.artifactUrl;
    this.loadedRegistry = this.registry;
    this.view = { kind: "loading" };
    void this.load(generation, request, this.registry);
  }

  private async load(generation: number, request: AbortController, registry: WorkflowArtifactRegistry): Promise<void> {
    try {
      const envelope = await fetchWorkflowArtifact(this.artifactUrl, window.location.href, request.signal);
      if (generation !== this.generation || !this.isConnected || request.signal.aborted) return;
      let card: WorkflowArtifactCard;
      try {
        card = registry.render(envelope, window.location.href);
      } catch {
        if (generation === this.generation && this.isConnected) {
          this.view = { kind: "fallback", text: envelope.fallbackText };
        }
        return;
      }
      if (generation === this.generation && this.isConnected) this.view = { kind: "card", card };
    } catch {
      if (generation === this.generation && this.isConnected && !request.signal.aborted) {
        this.view = { kind: "fallback", text: GENERIC_FALLBACK };
      }
    }
  }

  private originalLink(): TemplateResult | typeof nothing {
    try {
      const href = fileContentRoute(this.originalHref, window.location.href).href;
      return html`<a .href=${href} target="_blank" rel="noopener noreferrer">Open original file</a>`;
    } catch {
      return nothing;
    }
  }

  private itemValue(item: { value: string; href?: string }): TemplateResult {
    return item.href
      ? html`<a .href=${item.href} target="_blank" rel="noopener noreferrer">${item.value}</a>`
      : html`${item.value}`;
  }

  private cardView(card: WorkflowArtifactCard): TemplateResult {
    return html`<header>
        <h3>${card.heading}</h3>
        ${card.summary ? html`<p>${card.summary}</p>` : nothing}
        ${card.status ? html`<span class="status status-${card.status.tone}">${card.status.label}</span>` : nothing}
      </header>
      ${(card.sections ?? []).map(
        (section) =>
          html`<section>
            <h4>${section.label}</h4>
            <dl>
              ${section.items.map(
                (item) =>
                  html`${item.label ? html`<dt>${item.label}</dt>` : html`<dt>Detail</dt>`}
                    <dd>${this.itemValue(item)}</dd>`,
              )}
            </dl>
          </section>`,
      )}
      ${
        card.links?.length
          ? html`<section aria-label="Related links">
              <ul class="links">
                ${card.links.map(
                  (link) =>
                    html`<li><a .href=${link.href} target="_blank" rel="noopener noreferrer">${link.label}</a></li>`,
                )}
              </ul>
            </section>`
          : nothing
      } `;
  }

  protected override render(): TemplateResult {
    return html`<article
      aria-label="Workflow artifact"
      aria-live="polite"
      aria-busy=${this.view.kind === "loading" ? "true" : "false"}
    >
      ${
        this.view.kind === "card"
          ? this.cardView(this.view.card)
          : html`<header>
              <h3>${this.view.kind === "loading" ? "Loading workflow artifact…" : "Workflow artifact"}</h3>
              ${this.view.kind === "fallback" ? html`<p>${this.view.text}</p>` : nothing}
            </header>`
      }
      <footer>${this.originalLink()}</footer>
    </article>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("qm-workflow-artifact")) {
  customElements.define("qm-workflow-artifact", WorkflowArtifactElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "qm-workflow-artifact": WorkflowArtifactElement;
  }
}
