import { html, render } from "lit";
import { X } from "lucide";
import { reportHandledError } from "./browser-errors";
import { portalLoginUrl, withBase } from "./core-bridge";
import { tellEmbedder } from "./embedder";
import { icon } from "./icons";
import { appState, type Me } from "./shell-state";

const closeEmbed = (): void => tellEmbedder({ type: "qm:app-share-closed" });

function showProblem(title: string, message: string, action: { label: string; run: () => void }): void {
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog";
  dialog.setAttribute("aria-labelledby", "app-share-problem-heading");
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeEmbed();
  });
  document.body.append(dialog);
  render(
    html`<div class="project-dialog-head">
        <div>
          <h2 id="app-share-problem-heading">App permissions</h2>
          <p>${title}</p>
        </div>
        <button class="chip-x" type="button" aria-label="Close" @click=${closeEmbed}>${icon(X, 16)}</button>
      </div>
      <p>${message}</p>
      <div class="project-dialog-actions actions">
        <button class="btn" @click=${closeEmbed}>Close</button
        ><button class="btn primary" @click=${action.run}>${action.label}</button>
      </div>`,
    dialog,
  );
  dialog.showModal();
}

export async function bootAppShare(params: URLSearchParams): Promise<void> {
  document.documentElement.classList.add("app-share-embed");
  const slug = params.get("slug");
  const title = params.get("name") || slug || "";
  try {
    if (!slug) throw new Error("app-share opened without an app slug");
    const r = await fetch(withBase("/me"));
    if (r.status === 401)
      return showProblem(title, "You're signed out. Sign in, then open this again.", {
        label: "Sign in",
        run: () => window.open(portalLoginUrl(), "_blank", "noopener"),
      });
    if (!r.ok) {
      const body = await r.text().catch((e: unknown) => `<body unreadable: ${String(e)}>`);
      throw new Error(`app-share: /me answered ${r.status} ${body.slice(0, 200)}`);
    }
    appState.me = (await r.json()) as Me;
    const { openDeploymentPermissions } = await import("./deploy-permissions");
    await openDeploymentPermissions(slug, title, `personal:${appState.me.user}`, {
      onChange: () => tellEmbedder({ type: "qm:app-check" }),
      onClose: closeEmbed,
    });
  } catch (e) {
    reportHandledError("web-ui: app-share", e);
    showProblem(title, "Sharing settings couldn't load. This is usually temporary.", {
      label: "Try again",
      run: () => location.reload(),
    });
  }
}
