import { webFetch, withBase } from "./core-bridge";
import { tellEmbedder } from "./embedder";
import { appState, type Me } from "./shell-state";

const closeEmbed = (): void => tellEmbedder({ type: "qm:app-share-closed" });

export async function bootAppShare(params: URLSearchParams): Promise<void> {
  document.documentElement.classList.add("app-share-embed");
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.querySelector("dialog[open]")) closeEmbed();
  });
  const slug = params.get("slug");
  if (!slug) throw new Error("app-share opened without an app slug");
  const r = await webFetch(withBase("/me"));
  if (r.status === 401) return;
  if (!r.ok) {
    const body = await r.text().catch((e: unknown) => `<body unreadable: ${String(e)}>`);
    throw new Error(`app-share: /me answered ${r.status} ${body.slice(0, 200)}`);
  }
  appState.me = (await r.json()) as Me;
  const { openDeploymentPermissions } = await import("./deploy-permissions");
  const opened = openDeploymentPermissions(slug, params.get("name") || slug, `personal:${appState.me.user}`, {
    onChange: () => tellEmbedder({ type: "qm:app-check" }),
    onClose: closeEmbed,
  });
  tellEmbedder({ type: "qm:app-share-ready" });
  await opened;
}
