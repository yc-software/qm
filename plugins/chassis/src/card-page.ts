import { escapeHtml } from "./http.ts";

const CARD_STYLE = `<style>
  :root{
    --bg:#ffffff; --surface:#ffffff; --text:#0a0a0a; --muted:#737373;
    --border:#e5e5e5; --secondary:#f5f5f5; --warn:#b42318; --warn-bg:#fdeceb;
    --radius-md:10px; --radius-lg:16px;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0a0a0a; --surface:#171717; --text:#fafafa; --muted:#a3a3a3;
      --border:#2a2a2a; --secondary:#262626; --warn:#ff8a80; --warn-bg:#2a1a1a; }
  }
  *{ box-sizing:border-box; }
  html,body{ height:100%; }
  body{
    margin:0; background:var(--bg); color:var(--text); display:flex; min-height:100%;
    font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  main{ margin:auto; padding:32px 20px; width:100%; display:grid; place-items:center; }
  .card{
    width:100%; max-width:420px; background:var(--surface); border:1px solid var(--border);
    border-radius:var(--radius-lg); padding:34px 32px 30px; text-align:center;
  }
  .card.wide{ max-width:440px; }
  .icon{ width:52px; height:52px; margin:0 auto 18px; border-radius:var(--radius-md); background:var(--secondary);
    display:grid; place-items:center; }
  .icon svg{ width:26px; height:26px; stroke:var(--text); fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon.warn{ background:var(--warn-bg); }
  .icon.warn svg{ stroke:var(--warn); stroke-width:2; }
  h1{ font-size:20px; font-weight:600; letter-spacing:0; margin:0 0 8px; }
  .msg{ color:var(--muted); margin:0 auto 8px; max-width:40ch; font-size:14px; }
  .reason{ margin:16px auto 26px; font-size:13px; color:var(--text);
    background:var(--warn-bg); border:1px solid var(--border); border-radius:var(--radius-md); padding:11px 14px;
    text-align:left; word-break:break-word; }
  .reason strong{ display:block; color:var(--warn); font-size:11px; margin-bottom:3px; }
  .note{ margin:18px auto 26px; font-size:13px; color:var(--text); background:var(--secondary);
    border:1px solid var(--border); border-radius:var(--radius-md); padding:12px 14px; text-align:left; }
  .note .who{ display:flex; align-items:center; gap:8px; color:var(--muted); }
  .note .who b{ color:var(--text); }
  .note p{ margin:8px 0 0; color:var(--muted); }
  .actions{ display:grid; gap:10px; }
  .actions form{ display:grid; margin:0; }
  .btn{ display:flex; align-items:center; justify-content:center; min-height:44px; padding:0 18px;
    text-decoration:none; font-weight:600; font-size:14px; border-radius:var(--radius-md); cursor:pointer;
    transition:opacity .12s ease, background .12s ease, color .12s ease; }
  .btn.primary{ background:var(--text); color:var(--bg); border:1px solid var(--text); }
  .btn.primary:hover{ opacity:.9; }
  .btn.ghost{ background:none; color:var(--muted); border:1px solid var(--border); }
  .btn.ghost:hover{ background:var(--secondary); color:var(--text); }
  .btn:focus-visible{ outline:2px solid color-mix(in srgb, var(--text) 35%, transparent); outline-offset:2px; }
  .help{ color:var(--muted); font-size:12.5px; margin:20px 0 0; }
  @media (prefers-reduced-motion:reduce){ *{ transition:none !important; } }
</style>`;

export const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;
export const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

export function cardPage(o: {
  title: string;
  heading: string;
  msg: string;
  icon: string;
  warn?: boolean;
  wide?: boolean;
  extra?: string;
  actions: string;
  help: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)} · Portal</title>
${CARD_STYLE}
</head>
<body>
  <main>
    <section class="card${o.wide ? " wide" : ""}" aria-labelledby="t">
      <div class="icon${o.warn ? " warn" : ""}" aria-hidden="true">
        ${o.icon}
      </div>
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      ${o.msg ? `<p class="msg">${escapeHtml(o.msg)}</p>` : ""}
      ${o.extra ?? ""}
      <div class="actions">
        ${o.actions}
      </div>
      ${o.help ? `<p class="help">${escapeHtml(o.help)}</p>` : ""}
    </section>
  </main>
</body>
</html>`;
}
