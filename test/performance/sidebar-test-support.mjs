import { EventEmitter } from "node:events";
import { observe } from "./run.mjs";
import { model } from "./sidebar-test-model.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(transport = "navigation-post") {
  const m = model(transport),
    emitter = new EventEmitter(),
    origin = "http://127.0.0.1:9876";
  const sidebar = { ...m.facts, surface: "web", retention: { identities: new Map(), bytes: 0 } };
  const requirements =
    transport === "navigation-post"
      ? [{ path: "/api/session-navigation", method: "POST", captureNavigation: true, captureSidebar: true }]
      : ["/api/sessions", "/api/contexts"].map((path) => ({ path, captureSidebar: true }));
  const observer = observe(emitter, origin, requirements, sidebar);
  observer.start();
  function request(path, body, opts = {}) {
    const req = {
      url: () => origin + path,
      method: () => (body ? "POST" : "GET"),
      postData: () => (body ? JSON.stringify(body) : null),
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({}),
      failure: () => ({ errorText: opts.failure ?? "net::ERR_ABORTED" }),
    };
    emitter.emit("request", req);
    let reads = 0;
    return {
      req,
      reads: () => reads,
      respond(data, { raw, status = 200, bodyPromise } = {}) {
        const bytes = raw ?? Buffer.from(JSON.stringify(data));
        emitter.emit("response", {
          request: () => req,
          status: () => status,
          fromServiceWorker: () => false,
          allHeaders: async () => ({}),
          body: async () => {
            reads++;
            return bodyPromise ?? bytes;
          },
          json: async () => JSON.parse(bytes),
        });
      },
      finish() {
        emitter.emit("requestfinished", req);
      },
      fail() {
        emitter.emit("requestfailed", req);
      },
    };
  }
  function send(path, data, body, opts) {
    const r = request(path, body);
    r.respond(data, opts);
    r.finish();
    return r;
  }
  return { m, sidebar, observer, requirements, request, send };
}

export { setup, tick };
