import { LitElement, css, html, type PropertyValues } from "lit";

let sequence = 0;
let renderQueue: Promise<unknown> = Promise.resolve();
let engine: Promise<(typeof import("mermaid"))["default"]> | undefined;

const diagramConfig: import("mermaid").MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  look: "classic",
  layout: "dagre",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
  htmlLabels: false,
  flowchart: {
    htmlLabels: false,
    curve: "linear",
    wrappingWidth: 400,
    minNodeWidth: 32,
    nodeSpacing: 40,
    rankSpacing: 40,
    padding: 16,
  },
  maxTextSize: 50000,
  maxEdges: 500,
  suppressErrorRendering: true,
  secure: [
    "securityLevel",
    "startOnLoad",
    "maxTextSize",
    "maxEdges",
    "suppressErrorRendering",
    "htmlLabels",
    "flowchart",
    "theme",
    "look",
    "layout",
    "fontFamily",
    "themeCSS",
    "themeVariables",
  ],
};

function loadMermaid() {
  return (engine ??= import("mermaid")
    .then(({ default: mermaid }) => mermaid)
    .catch((error: unknown) => {
      engine = undefined;
      throw error;
    }));
}

export async function renderMermaid(
  source: string,
  id: string,
  staging: HTMLElement,
  dark = false,
): Promise<{ svg: string }> {
  if (source.length > 50000) throw new Error("Diagram is too large");
  const mermaid = await loadMermaid();
  const operation = renderQueue.then(async () => {
    mermaid.initialize({
      ...diagramConfig,
      themeVariables: {
        darkMode: dark,
        background: "transparent",
        primaryColor: dark ? "#30343b" : "#f4f5f7",
        primaryTextColor: dark ? "#f1f3f5" : "#24272d",
        primaryBorderColor: dark ? "#555b64" : "#cbd0d8",
        secondaryColor: dark ? "#272c34" : "#eef1f5",
        tertiaryColor: dark ? "#242931" : "#f8f9fb",
        lineColor: dark ? "#aeb4bf" : "#69717d",
        textColor: dark ? "#f1f3f5" : "#24272d",
        edgeLabelBackground: "transparent",
        fontSize: "16px",
      },
      themeCSS:
        ".node rect { rx: 10px; ry: 10px; } .node rect, .node polygon, .node circle, .node path { filter: none; stroke-width: 1px; } .edgeLabel, .labelBkg { background: transparent; }",
    });
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    if (diagram.type.startsWith("flowchart")) {
      const db = diagram.db as unknown as { getData(): { nodes: Array<{ img?: string; shape?: string }> } };
      const data = db.getData();
      if (data.nodes.some((node) => node.img !== undefined || node.shape?.startsWith("image")))
        throw new Error("Images are not supported in chat diagrams");
    }
    return mermaid.render(id, source, staging);
  });
  renderQueue = operation.catch(() => undefined);
  return operation;
}

export class MermaidBlock extends LitElement {
  static properties = {
    code: {},
    pending: { type: Boolean, reflect: true },
    image: { state: true },
    error: { state: true },
  };

  declare code: string;
  declare pending: boolean;
  private image = "";
  private error = false;
  private themeObserver?: MutationObserver;
  private revision = 0;
  private width = 0;
  private height = 0;

  static styles = css`
    :host {
      display: block;
      min-width: 0;
      margin: 1em 0;
      position: relative;
    }
    .viewport {
      padding: 24px 0;
    }
    img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: auto;
    }
    details {
      padding: 4px 0;
    }
    summary {
      cursor: pointer;
      font: 12px var(--app-font, system-ui);
      color: var(--muted-foreground, #858b95);
    }
    pre {
      max-height: 600px;
      overflow: auto;
      font: 13px/1.5 monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    p {
      margin: 12px 14px;
      font: 13px system-ui;
    }
  `;

  constructor() {
    super();
    this.code = "";
    this.pending = false;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("code") || changed.has("pending")) void this.draw();
  }

  disconnectedCallback(): void {
    this.revision++;
    this.themeObserver?.disconnect();
    super.disconnectedCallback();
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.toggleAttribute("dark", document.documentElement.classList.contains("dark"));
    this.themeObserver = new window.MutationObserver(() => {
      const dark = document.documentElement.classList.contains("dark");
      if (dark === this.hasAttribute("dark")) return;
      this.toggleAttribute("dark", dark);
      void this.draw();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    if (this.hasUpdated) void this.draw();
  }

  private async draw(): Promise<void> {
    const revision = ++this.revision;
    this.image = "";
    this.error = false;
    if (this.pending || !this.code.trim()) return;
    const completion = Promise.withResolvers<void>();
    this.dispatchEvent(
      new window.CustomEvent("qm-content-updating", { bubbles: true, composed: true, detail: completion.promise }),
    );
    const id = `qm-mermaid-${++sequence}`;
    const staging = document.createElement("div");
    staging.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.append(staging);
    try {
      if (revision !== this.revision || !this.isConnected) return;
      const { svg } = await renderMermaid(this.code, id, staging, this.hasAttribute("dark"));
      if (revision !== this.revision || !this.isConnected) return;
      const document = new DOMParser().parseFromString(svg, "image/svg+xml");
      const viewBox = document.documentElement.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
      this.width = viewBox?.[2] || 640;
      this.height = viewBox?.[3] || 480;
      if (this.height > 12000 || this.width > 20000) throw new Error("Diagram dimensions are too large");
      this.image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      if (revision === this.revision) this.error = true;
    } finally {
      staging.remove();
      await this.updateComplete;
      this.dispatchEvent(new window.Event("qm-content-updated", { bubbles: true, composed: true }));
      completion.resolve();
    }
  }

  protected render() {
    let status = "Rendering diagram…";
    if (this.pending) status = "Diagram will render when the reply finishes.";
    else if (this.error) status = "Unable to render this diagram. Its source is shown below.";
    return html`
      ${this.image ? html`<div class="viewport"><img src=${this.image} width=${this.width} height=${this.height} alt="Mermaid diagram. Diagram source is available below." /></div>` : html`<p role="status">${status}</p>`}
      <details ?open=${!this.image}>
        <summary>Source</summary>
        <pre><code>${this.code}</code></pre>
      </details>
    `;
  }
}

if (!customElements.get("qm-mermaid")) customElements.define("qm-mermaid", MermaidBlock);
