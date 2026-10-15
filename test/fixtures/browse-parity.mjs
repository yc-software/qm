import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const style = `
body { font: 16px system-ui; margin: 24px; color: #18212b; }
section { margin: 24px 0; padding: 16px; border: 1px solid #aaa; }
button, input, select, textarea { font: inherit; margin: 6px; padding: 6px; }
iframe { display: block; width: 94%; height: 380px; margin: 12px; border: 2px solid #789; }
#state { white-space: pre-wrap; overflow: auto; height: 240px; background: #eee; }
#hover-menu { display: none; }
#hover-target:hover #hover-menu { display: block; }
#hover-target { width: 240px; height: 100px; padding: 12px; background: #def; }
#drag-source, #drop-target { display: inline-block; padding: 30px; margin: 12px; border: 2px solid #567; }
#scroll-container { overflow: auto; height: 160px; width: 360px; border: 2px solid #567; }
#scroll-content { height: 650px; width: 900px; position: relative; }
#scroll-bottom { position: absolute; bottom: 8px; right: 8px; }
#editable { min-height: 48px; border: 1px solid #789; padding: 8px; }
#page-bottom { margin-top: 900px; }
`;

const client = String.raw`
const state = window.fixtureState = { events: [], values: {}, files: {}, dialogs: {}, frames: {}, network: [], history: [] };
const $ = id => document.getElementById(id);
const render = () => { $('state').textContent = JSON.stringify(state); };
const record = (type, data = {}) => {
  const event = { seq: state.events.length + 1, type, ...data };
  state.events.push(event);
  render();
  if (window !== window.top) window.top.postMessage({ fixture: true, label: document.body.dataset.label, event }, '*');
};
window.resetFixtureState = () => {
  for (const key of Object.keys(state)) state[key] = Array.isArray(state[key]) ? [] : {};
  render();
};
$('reset-state').onclick = window.resetFixtureState;
const targetId = event => event.composedPath().find(node => node.id)?.id || event.target.tagName;
for (const type of ['click', 'auxclick', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'beforeinput', 'input', 'change']) {
  document.addEventListener(type, event => {
    if (event.type === 'contextmenu') event.preventDefault();
    const target = event.composedPath()[0];
    const data = { target: targetId(event), trusted: event.isTrusted };
    for (const key of ['button', 'buttons', 'detail', 'key', 'code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey', 'inputType', 'data']) {
      if (event[key] !== undefined) data[key] = event[key];
    }
    if ('value' in target && target.type !== 'file') state.values[data.target] = target.value;
    if (target.isContentEditable) state.values[data.target] = target.textContent;
    if (target.type === 'checkbox' || target.type === 'radio') {
      for (const input of document.querySelectorAll('input[type=checkbox], input[type=radio]')) state.values[input.id] = input.checked;
    }
    if (target.multiple && target.tagName === 'SELECT') state.values[data.target] = [...target.selectedOptions].map(option => option.value);
    record(type, data);
  });
}
window.addEventListener('message', event => {
  if (!event.data?.fixture) return;
  state.frames[event.data.label] ??= [];
  state.frames[event.data.label].push({ origin: event.origin, ...event.data.event });
  render();
});
for (const host of document.querySelectorAll('[data-shadow]')) {
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<button id="shadow-button">Shadow button</button><label>Shadow input <input id="shadow-input"></label><div id="nested-shadow"></div>';
  root.querySelector('#nested-shadow').attachShadow({ mode: 'open' }).innerHTML = '<button id="deep-shadow-button">Deep shadow button</button>';
}
if ($('hover-target')) {
  $('hover-target').onmouseenter = () => record('hover', { target: 'hover-target' });
  $('hover-action').onclick = () => record('hover-action');
  $('drag-source').ondragstart = event => {
    event.dataTransfer.setData('text/plain', 'parity-payload');
    event.dataTransfer.effectAllowed = 'copy';
    record('dragstart', { target: 'drag-source' });
  };
  $('drop-target').ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };
  $('drop-target').ondrop = event => {
    event.preventDefault();
    state.values.drop = event.dataTransfer.getData('text/plain');
    record('drop', { text: state.values.drop });
  };
  $('drag-source').ondragend = event => record('dragend', { dropEffect: event.dataTransfer.dropEffect });
  $('scroll-container').onscroll = event => record('scroll', { target: 'scroll-container', x: event.target.scrollLeft, y: event.target.scrollTop });
  window.addEventListener('scroll', () => record('scroll', { target: 'window', x: scrollX, y: scrollY }));
  for (const kind of ['alert', 'confirm', 'prompt']) $('dialog-' + kind).onclick = () => {
    record('dialog-open', { kind });
    state.dialogs[kind] = kind === 'alert' ? (alert('Parity alert'), 'closed') : kind === 'confirm' ? confirm('Parity confirm?') : prompt('Parity prompt?', 'default answer');
    record('dialog-result', { kind, value: state.dialogs[kind] });
  };
  window.addEventListener('beforeunload', event => {
    if (!$('beforeunload').checked) return;
    event.preventDefault();
    event.returnValue = '';
  });
  $('download-blob').onclick = () => {
    const url = URL.createObjectURL(new Blob(['parity blob download\n'], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'parity-blob.txt';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  for (const input of document.querySelectorAll('input[type=file]')) input.onchange = async () => {
    state.files[input.id] = await Promise.all([...input.files].map(async file => ({ name: file.name, type: file.type, size: file.size, relativePath: file.webkitRelativePath, text: await file.text() })));
    record('files', { target: input.id, files: state.files[input.id] });
  };
  $('choose-files').onclick = () => $('hidden-files').click();
  $('add-delayed').onclick = () => {
    $('delayed-target')?.remove();
    setTimeout(() => {
      const button = document.createElement('button');
      button.id = 'delayed-target';
      button.textContent = 'Delayed target';
      $('dynamic-area').append(button);
      record('delayed-ready');
    }, 250);
  };
  $('detach-target').onpointerdown = event => { event.currentTarget.remove(); record('detached'); };
  $('rerender').onclick = () => {
    const old = $('rerender-target');
    const next = old.cloneNode(true);
    next.dataset.generation = String(Number(old.dataset.generation) + 1);
    next.textContent = 'Rendered target ' + next.dataset.generation;
    old.replaceWith(next);
    record('rerendered', { generation: Number(next.dataset.generation) });
  };
  $('network-get').onclick = () => request('/api/echo?source=get');
  $('network-post').onclick = () => request('/api/echo?source=post', { method: 'POST', headers: { 'content-type': 'application/json', 'x-parity-request': 'present' }, body: JSON.stringify({ message: 'parity post' }) });
  $('network-delayed').onclick = () => request('/api/echo?delay=250');
  $('network-error').onclick = () => request('/api/echo?status=418');
  $('network-cross').onclick = () => request(document.body.dataset.crossOrigin + '/api/echo?source=cross');
}
async function request(url, options) {
  try {
    const response = await fetch(url, options);
    const body = await response.json();
    state.network.push({ url, status: response.status, header: response.headers.get('x-parity-response'), body });
    record('network-response', { url, status: response.status });
  } catch (error) { record('network-error', { url, message: String(error) }); }
}
if ($('history-push')) {
  const trackHistory = type => { state.history.push({ type, path: location.pathname + location.search + location.hash, state: history.state }); render(); };
  $('history-push').onclick = () => { history.pushState({ step: 1 }, '', '?step=1'); trackHistory('push'); };
  $('history-replace').onclick = () => { history.replaceState({ step: 2 }, '', '?step=2'); trackHistory('replace'); };
  $('history-back').onclick = () => history.back();
  $('history-forward').onclick = () => history.forward();
  window.addEventListener('popstate', () => trackHistory('popstate'));
  window.addEventListener('hashchange', () => trackHistory('hashchange'));
  trackHistory('load');
}
record('ready', { label: document.body.dataset.label });
`;

const controls = `
<section id="pointer"><h2>Pointer</h2><button id="click-target">Click target</button></section>
<section id="keyboard"><h2>Keyboard and forms</h2>
<label>Text <input id="text-input"></label><label>Textarea <textarea id="textarea"></textarea></label>
<div id="editable" contenteditable="true" role="textbox" aria-label="Editable text">Editable seed</div>
<label><input id="checkbox" type="checkbox">Checkbox</label>
<label><input id="radio-a" type="radio" name="choice" value="a">Radio A</label>
<label><input id="radio-b" type="radio" name="choice" value="b">Radio B</label>
<label>Single select <select id="select"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label>Multiple select <select id="multi-select" multiple><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select></label>
</section><section id="shadows"><h2>Shadow DOM</h2><div id="shadow-host" data-shadow></div></section>
`;

const navigation = `
<section id="navigation"><h2>Navigation</h2>
<a id="navigate" href="/navigation?step=arrived">Navigate</a>
<a id="home" href="/">Home</a><a id="hash-link" href="#navigation">Hash link</a>
<button id="history-push">Push state</button><button id="history-replace">Replace state</button>
<button id="history-back">Back</button><button id="history-forward">Forward</button>
<a id="popup-link" href="/popup" target="_blank">Open popup</a>
</section>`;

const activities = `
<section><h2>Hover and drag</h2><div id="hover-target">Hover here<div id="hover-menu"><button id="hover-action">Hover action</button></div></div>
<div id="drag-source" draggable="true">Drag source</div><div id="drop-target">Drop target</div></section>
<section><h2>Scrolling</h2><div id="scroll-container"><div id="scroll-content"><button id="scroll-bottom">Scroll bottom</button></div></div></section>
<section><h2>Dialogs</h2><button id="dialog-alert">Alert</button><button id="dialog-confirm">Confirm</button><button id="dialog-prompt">Prompt</button><label><input id="beforeunload" type="checkbox">Enable beforeunload</label></section>
<section><h2>Downloads</h2><a id="download-get" href="/download" download>Download GET</a>
<form method="post" action="/download"><input name="payload" value="parity post download"><button id="download-post">Download POST</button></form>
<button id="download-blob">Download blob</button></section>
<section><h2>Files</h2><label>One file <input id="file" type="file"></label><label>Many files <input id="files" type="file" multiple></label>
<label>Directory <input id="directory" type="file" webkitdirectory multiple></label><input id="hidden-files" type="file" multiple hidden><button id="choose-files">Choose files</button></section>
<section id="dynamic-area"><h2>Dynamic elements</h2><button id="add-delayed">Add delayed target</button><button id="detach-target">Detach on pointerdown</button><button id="rerender">Re-render target</button><button id="rerender-target" data-generation="0">Rendered target 0</button></section>
<section><h2>Network</h2><button id="network-get">GET request</button><button id="network-post">POST request</button><button id="network-delayed">Delayed request</button><button id="network-error">HTTP error</button><button id="network-cross">Cross-origin request</button></section>
`;

const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function startFixture(options = {}) {
  const sockets = new Set();
  const timers = new Set();
  let mainUrl;
  let crossOriginUrl;
  let closing;
  const servers = [createServer(handle), createServer(handle)];
  function handle(req, res) {
    const url = new URL(req.url, "http://fixture.invalid");
    res.setHeader("cache-control", "no-store");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-parity-request");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-expose-headers", "x-parity-response");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/api/echo" || url.pathname === "/download") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("error", () => res.destroy());
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        if (url.pathname === "/download") {
          res.writeHead(200, {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="parity-' + req.method.toLowerCase() + '.txt"',
          });
          res.end(req.method === "POST" ? body : "parity get download\n");
          return;
        }
        const respond = () => {
          const status = Number(url.searchParams.get("status") || 200);
          res.writeHead(status >= 200 && status <= 599 ? status : 400, {
            "content-type": "application/json",
            "x-parity-response": "present",
          });
          res.end(
            JSON.stringify({
              method: req.method,
              path: url.pathname,
              query: Object.fromEntries(url.searchParams),
              headers: req.headers,
              body,
            }),
          );
        };
        const delay = Math.min(5000, Math.max(0, Number(url.searchParams.get("delay")) || 0));
        if (!delay) respond();
        else {
          const timer = setTimeout(() => {
            timers.delete(timer);
            respond();
          }, delay);
          timers.add(timer);
          res.on("close", () => {
            clearTimeout(timer);
            timers.delete(timer);
          });
        }
      });
      return;
    }
    if (url.pathname === "/client.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(client);
      return;
    }
    if (!["/", "/frames", "/frame", "/navigation", "/popup"].includes(url.pathname)) {
      res.writeHead(404).end("Not found");
      return;
    }
    const mainOrigin = options.mainOrigin || mainUrl;
    const crossOrigin = options.crossOrigin || crossOriginUrl;
    const label = url.searchParams.get("label") || url.pathname.slice(1) || "main";
    let content = controls;
    if (url.pathname === "/" || url.pathname === "/frames") {
      content += `<section id="frames"><h2>Frames</h2><iframe id="same-frame" title="Same origin frame" src="/frame?label=same&amp;nested=1"></iframe><iframe id="cross-frame" title="Cross origin frame" src="${escapeHtml(crossOrigin)}/frame?label=cross&amp;nested=1"></iframe></section>`;
    }
    if (url.pathname === "/frame" && url.searchParams.get("nested") === "1") {
      content += `<iframe id="nested-same-frame" title="Nested same origin frame" src="/frame?label=${escapeHtml(label)}-nested-same"></iframe><iframe id="nested-cross-frame" title="Nested cross origin frame" src="${escapeHtml(label === "cross" ? mainOrigin : crossOrigin)}/frame?label=${escapeHtml(label)}-nested-cross"></iframe>`;
    }
    if (url.pathname !== "/frame") content += navigation;
    if (url.pathname === "/") content += activities + '<button id="page-bottom">Page bottom</button>';
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Parity ${escapeHtml(label)}</title><style>${style}</style></head><body data-label="${escapeHtml(label)}" data-cross-origin="${escapeHtml(crossOrigin)}"><h1>Parity ${escapeHtml(label)}</h1><button id="reset-state">Reset state</button><pre id="state" aria-label="Fixture state"></pre>${content}<script src="/client.js"></script></body></html>`,
    );
  }
  const close = () =>
    (closing ??= (async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const closed = servers.map(
        (server) =>
          new Promise((resolve, reject) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      );
      for (const socket of sockets) socket.destroy();
      await Promise.all(closed);
    })());
  try {
    for (const [index, server] of servers.entries()) {
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(index ? options.crossPort || 0 : options.port || 0, options.host || "0.0.0.0", () => {
          server.off("error", reject);
          resolve();
        });
      });
    }
    mainUrl = `http://localhost:${servers[0].address().port}`;
    crossOriginUrl = `http://127.0.0.1:${servers[1].address().port}`;
    return { mainUrl, crossOriginUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startFixture({
    port: Number(process.env.PORT) || 0,
    crossPort: Number(process.env.CROSS_PORT) || 0,
    mainOrigin: process.env.MAIN_ORIGIN,
    crossOrigin: process.env.CROSS_ORIGIN,
  });
  console.log(JSON.stringify({ mainUrl: fixture.mainUrl, crossOriginUrl: fixture.crossOriginUrl }));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void fixture.close();
    });
}
