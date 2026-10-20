const api = window.permissions;
const message = document.getElementById("message");
const enable = document.getElementById("enable");
const proceed = document.getElementById("continue");
const names = { accessibility: "Accessibility", screen_recording: "Screen & System Audio Recording" };
let selected = "accessibility";
let checking = false;
let requesting = false;
async function refresh() {
  if (checking || requesting) return;
  checking = true;
  try {
    const state = await api.status();
    document.querySelectorAll("[data-name]").forEach((node) => {
      node.textContent = state.name;
    });
    if (state.icon) document.getElementById("icon").src = state.icon;
    for (const permission of ["accessibility", "screen_recording"]) {
      const label = document.getElementById(`${permission}-status`);
      label.textContent = state[permission] ? "✓ Allowed" : "Needs access";
      label.classList.toggle("ready", state[permission]);
    }
    const ready = state.accessibility && state.screen_recording;
    enable.hidden = ready;
    proceed.hidden = !ready;
    message.textContent = ready
      ? "You're ready. Both permissions are enabled."
      : "We haven’t detected both permissions yet. Follow the steps above, then check again.";
  } catch (error) {
    message.textContent = error.message;
  } finally {
    checking = false;
  }
}
async function action(callback) {
  try {
    await callback();
  } catch (error) {
    message.textContent = error.message;
  }
}
document.querySelectorAll("[data-settings]").forEach((button) => {
  button.addEventListener("click", () =>
    action(async () => {
      selected = button.dataset.settings;
      document.getElementById("guide-title").textContent = `Enable ${names[selected]}`;
      document.getElementById("destination").textContent =
        `Drop this app into the ${names[selected]} list, then turn on its switch.`;
      await api.settings(selected);
    }),
  );
});
document.getElementById("finder").addEventListener("click", () => action(() => api.finder()));
document.getElementById("drag").addEventListener("dragstart", (event) => {
  event.preventDefault();
  api.drag();
});
document.getElementById("later").addEventListener("click", () => action(() => api.close(false)));
proceed.addEventListener("click", () =>
  action(async () => {
    if (!(await api.close(true))) {
      message.textContent = "Access changed. Enable both permissions to continue.";
      await refresh();
    }
  }),
);
enable.addEventListener("click", async () => {
  requesting = true;
  enable.disabled = true;
  await action(() => api.prompt());
  requesting = false;
  enable.disabled = false;
  await refresh();
});
document.getElementById("check").addEventListener("click", refresh);
window.addEventListener("focus", refresh);
const timer = setInterval(refresh, 2000);
window.addEventListener("pagehide", () => clearInterval(timer));
void refresh();
