window.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  const mac = process.platform === "darwin";
  root.dataset.qmDesktop = process.platform;
  const style = document.createElement("style");
  style.textContent = `
    html[data-qm-desktop="darwin"] body { padding-top: 48px; }
    html[data-qm-desktop="darwin"] body::before {
      content: ""; position: fixed; inset: 0 0 auto; height: 48px;
      background: var(--background, #f5f4f0); z-index: 100;
      -webkit-app-region: drag;
    }
    html[data-qm-desktop="darwin"] .layout { height: calc(100dvh - 48px); }
    html[data-qm-desktop="darwin"] .layout.bannered {
      height: calc(100dvh - 86px - env(safe-area-inset-top));
    }
    html[data-qm-desktop="darwin"] .top-banner { top: 48px; }
    @media (max-width: 860px) {
      html[data-qm-desktop="darwin"] .layout { top: 48px; }
    }
    @media (min-width: 861px) {
      html[data-qm-desktop="darwin"]:has(.layout:not(.bannered)) body { padding-top: 0; }
      html[data-qm-desktop="darwin"]:has(.layout:not(.bannered)) body::before { display: none; }
      html[data-qm-desktop="darwin"] .layout:not(.bannered) { height: 100dvh; --rail-w: 100px; }
      html[data-qm-desktop="darwin"] .layout:not(.bannered) .sidebar { padding-top: 0; }
      html[data-qm-desktop="darwin"] .layout:not(.bannered) .brand {
        height: 56px; min-height: 56px; box-sizing: border-box; padding: 0 8px 0 92px;
        justify-content: flex-end; -webkit-app-region: drag; user-select: none;
      }
      html[data-qm-desktop="darwin"] .layout:not(.bannered) .brand-lockup { display: none; }
      html[data-qm-desktop="darwin"] .layout:not(.bannered).sidebar-closed .brand {
        height: 96px; min-height: 96px; padding: 48px 0 8px; justify-content: center;
      }
      html[data-qm-desktop="darwin"] .brand button { -webkit-app-region: no-drag; }
      html[data-qm-desktop="darwin"] .dv-tabs-and-actions-container,
      html[data-qm-desktop="darwin"] .chat-topbar { -webkit-app-region: drag; }
      html[data-qm-desktop="darwin"] .dv-tabs-and-actions-container :is(button, a, input, [role="tab"], .dv-tab),
      html[data-qm-desktop="darwin"] .chat-topbar :is(button, a, input, [role="tab"]) {
        -webkit-app-region: no-drag;
      }
    }
    html[data-qm-desktop="darwin"] .single-pane .dv-tabs-and-actions-container .dv-tab {
      -webkit-app-region: drag; user-select: none;
    }
    html[data-qm-desktop="darwin"] .single-pane .dv-tab :is(button, a, input) {
      -webkit-app-region: no-drag;
    }
    [data-qm-shortcut] { position: relative; }
    html[data-qm-shortcuts] [data-qm-shortcut] { padding-right: 48px !important; }
    [data-qm-shortcut]::after {
      content: attr(data-qm-shortcut); display: none; position: absolute; right: 7px;
      top: 50%; transform: translateY(-50%); min-width: 28px; height: 20px;
      align-items: center; justify-content: center; box-sizing: border-box;
      padding: 0 4px; border: 1px solid var(--border, #ddd); border-radius: 5px;
      background: var(--background, #f5f4f0); color: var(--muted-foreground, #777);
      font: 11px ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums;
      pointer-events: none;
    }
    html[data-qm-shortcuts] [data-qm-shortcut]::after { display: flex; }
    html[data-qm-shortcuts] .session-row:has([data-qm-shortcut]) .session-menu { visibility: hidden; }
  `;
  document.head.append(style);
  let links = [];
  let held = false;
  const clear = () => {
    held = false;
    delete root.dataset.qmShortcuts;
  };
  const refresh = () => {
    for (const link of links) delete link.dataset.qmShortcut;
    const seen = new Set();
    links = [...document.querySelectorAll("#sidebar-body .session-row[data-session-id] > a.session[href]")]
      .filter((link) => {
        const id = link.parentElement.dataset.sessionId;
        if (seen.has(id) || !link.checkVisibility({ checkVisibilityCSS: true })) return false;
        seen.add(id);
        return true;
      })
      .slice(0, 9);
    links.forEach((link, index) => {
      link.dataset.qmShortcut = `${mac ? "⌘" : "Ctrl "}${index + 1}`;
    });
  };
  window.addEventListener(
    "keydown",
    (event) => {
      const modifier = mac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey || (mac && event.ctrlKey) || (!mac && event.metaKey)) {
        clear();
        return;
      }
      if (event.isComposing || document.querySelector('dialog[open], [aria-modal="true"]:not(.sidebar)')) {
        clear();
        return;
      }
      refresh();
      held = true;
      root.dataset.qmShortcuts = "";
      const index = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
      const link = links[index];
      if (!link) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) link.click();
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (event) => {
      if (!(mac ? event.metaKey : event.ctrlKey)) clear();
    },
    true,
  );
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", clear);
  new MutationObserver(() => {
    if (held) refresh();
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });
});
