import { BrowserWindow, ipcMain, session } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desk } from "./desk.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(directory, "runtime.html");
const commands = new Set(["apps", "observe", "act"]);
const cancelled = new Set();
let window;
let ready;
let owner;
let execution;
let fresh = true;
let queue = Promise.resolve();
let generation = 0;
let lifecycle = 0;

function close() {
  generation++;
  execution = undefined;
  const current = window;
  window = undefined;
  ready = undefined;
  fresh = true;
  if (current && !current.isDestroyed()) current.destroy();
  desk.stop();
}

export function stopComputer(client) {
  if (!client) lifecycle++;
  if (client) cancelled.add(client);
  if (client && client !== owner) return;
  if (owner) cancelled.add(owner);
  owner = undefined;
  close();
}

export function registerComputerRuntime(onReply) {
  ipcMain.handle("qm:runtime-desk", (event, cmd) => {
    const active = execution;
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== pathToFileURL(page).href ||
      !active ||
      cancelled.has(active.owner) ||
      Date.now() >= active.deadline
    )
      throw new Error("Computer execution is no longer active");
    if (!commands.has(cmd?.type)) throw new Error("Unsupported desk command");
    if (cmd.type === "act" && (!Array.isArray(cmd.actions) || cmd.actions.length > 20))
      throw new Error("Invalid action batch");
    const result = desk.request(cmd, active.owner, active.deadline).then(onReply);
    active.calls.push(result);
    return result;
  });
}

function open() {
  if (window && !window.isDestroyed()) return ready;
  const isolated = session.fromPartition("qm-computer");
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: isolated,
      preload: path.join(directory, "runtime-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.debugger.attach("1.3");
  ready = window.loadFile(page);
  return ready;
}

async function evaluate(args, client, deadline) {
  if (cancelled.has(client) || Date.now() >= deadline) throw new Error("Desktop turn has ended");
  if (owner && owner !== client)
    throw new Error("Another desktop turn is using computer access; wait for it to finish");
  owner = client;
  if (args.reset) close();
  const expected = generation;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        close();
        reject(new Error("Computer call timed out; actions may have completed. Observe before retrying."));
      },
      Math.max(1, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        await open();
        if (cancelled.has(client) || owner !== client || expected !== generation)
          throw new Error("Desktop turn has ended");
        const current = window;
        const cdp = (method, params) => current.webContents.debugger.sendCommand(method, params);
        const active = { owner: client, deadline, calls: [] };
        execution = active;
        const outcome = await cdp("Runtime.evaluate", { expression: args.code, replMode: true, awaitPromise: true });
        if (execution !== active || expected !== generation) throw new Error("Desktop turn has ended");
        execution = undefined;
        await Promise.all(active.calls);
        if (expected !== generation) throw new Error("Desktop turn has ended");
        let value;
        if (!outcome.exceptionDetails && outcome.result.type !== "undefined") {
          value = outcome.result.objectId
            ? (
                await cdp("Runtime.callFunctionOn", {
                  objectId: outcome.result.objectId,
                  functionDeclaration: "function () { return __describe(this); }",
                  returnByValue: true,
                })
              ).result.value
            : (outcome.result.description ?? String(outcome.result.value));
        }
        const { text, images } = (await cdp("Runtime.evaluate", { expression: "__drain()", returnByValue: true }))
          .result.value;
        const docs = fresh
          ? (await cdp("Runtime.evaluate", { expression: "__docs", returnByValue: true })).result.value
          : "";
        fresh = false;
        const error = outcome.exceptionDetails?.exception?.description ?? outcome.exceptionDetails?.text;
        return {
          content:
            [docs, text, value === undefined ? "" : `=> ${value}`, error ? `[error] ${error}` : ""]
              .filter(Boolean)
              .join("\n\n") || "[no output]",
          ...(images.length ? { images } : {}),
          ...(error ? { isError: true } : {}),
        };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    execution = undefined;
  }
}

export function callComputer(args, client, deadline) {
  if (
    !args ||
    typeof args.code !== "string" ||
    args.code.length > 100_000 ||
    (args.reset !== undefined && typeof args.reset !== "boolean")
  )
    return Promise.reject(new Error("desktop requires JavaScript code"));
  const expires = Math.min(deadline, Date.now() + 50_000);
  const submitted = lifecycle;
  const job = queue.then(() => {
    if (submitted !== lifecycle) throw new Error("Desktop turn has ended");
    return evaluate(args, client, expires);
  });
  queue = job.catch(() => {});
  return job;
}
