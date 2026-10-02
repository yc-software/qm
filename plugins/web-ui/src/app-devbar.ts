import { init, type DevbarPayload } from "devbar.sh";

const scope = crypto.randomUUID();
let instance: ReturnType<typeof init> | undefined;
const publish = (payload: DevbarPayload): void => {
  window.parent.postMessage({ type: "qm:devbar-snapshot", payload: { ...payload, scope } }, window.location.origin);
};
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin) return;
  if (event.data?.type !== "qm:devbar-toggle") return;
  const { on, chatOpen } = event.data;
  document.documentElement.dataset.qmAnnotating = String(Boolean(on));
  document.documentElement.dataset.qmChatOpen = String(Boolean(chatOpen));
  if ((on || chatOpen) && !instance) {
    instance = init({ onSubmit: publish, local: false, live: false, tools: ["select", "marker", "draw", "capture"] });
  }
  const root = document.querySelector<HTMLElement>("[data-devbar=root]");
  root?.toggleAttribute("hidden", !on && !chatOpen);
  if (root) root.dataset.passive = String(!on);
});
window.parent.postMessage({ type: "qm:devbar-ready" }, window.location.origin);
