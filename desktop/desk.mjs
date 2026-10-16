import { app } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { flyTo } from "./cursor.mjs";

const binary =
  process.env.QM_DESK_BIN ??
  (app.isPackaged
    ? path.join(process.resourcesPath, "desk")
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "desk/target/release/desk"));
const paced = process.env.QM_DESK_CURSOR !== "0";
let child;
let pending;
let activeOwner;
let queue = Promise.resolve();
let next = 1;
let generation = 0;
const cancelled = new Set();

function stop(message = "Desktop computer access ended", owner) {
  if (owner && activeOwner !== owner) return;
  activeOwner = undefined;
  if (!owner) generation++;
  const proc = child;
  child = undefined;
  pending?.finish({ type: "error", code: "action_failed", message, action: null });
  proc?.kill("SIGKILL");
}

function start() {
  if (child) return child;
  const proc = spawn(binary, ["serve"], { stdio: ["pipe", "pipe", "inherit"] });
  child = proc;
  const fail = (error) => {
    if (child === proc) stop(`desk stopped: ${error.message}`);
  };
  proc.on("error", fail);
  proc.stdin.on("error", fail);
  proc.on("exit", (code, signal) => fail(new Error(`exit ${code ?? signal}`)));
  createInterface({ input: proc.stdout }).on("line", (line) => {
    if (child !== proc || !pending) return;
    try {
      const response = JSON.parse(line);
      if (response.id !== pending.id) throw new Error("Unexpected desk response id");
      if (response.reply.type !== "pointer") pending.finish(response.reply);
      else {
        const id = pending.id;
        void flyTo(response.reply.point)
          .then(() => {
            if (child === proc && pending?.id === id)
              proc.stdin.write(`${JSON.stringify({ id, cmd: { type: "arrived" } })}\n`);
          })
          .catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  });
  return proc;
}

function request(cmd, owner, deadline = Date.now() + 45_000) {
  const expiresAt = Math.min(deadline, Date.now() + 45_000);
  const submitted = generation;
  const run = () =>
    new Promise((resolve) => {
      if (submitted !== generation || cancelled.has(owner) || Date.now() >= expiresAt)
        return resolve({
          type: "error",
          code: "action_failed",
          message: "Desktop access ended before this action began",
        });
      if (activeOwner !== undefined && activeOwner !== owner)
        return resolve({
          type: "error",
          code: "action_failed",
          message: "Another desktop turn is using computer access. Wait for it to finish, then observe before acting.",
        });
      activeOwner = owner;
      const proc = start();
      const id = next++;
      const timer = setTimeout(
        () => stop("Computer action timed out; its outcome may be unknown. Observe before retrying."),
        Math.max(1, expiresAt - Date.now()),
      );
      pending = {
        id,
        owner,
        finish: (reply) => {
          clearTimeout(timer);
          pending = undefined;
          resolve(reply);
        },
      };
      proc.stdin.write(`${JSON.stringify({ id, cmd })}\n`);
    });
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}

export const desk = {
  request: (cmd, owner, deadline) => request(cmd.type === "act" ? { ...cmd, pace: paced } : cmd, owner, deadline),
  stop,
  cancel: (owner) => {
    cancelled.add(owner);
    stop("Computer access ended", owner);
  },
  apps: (owner, deadline) => request({ type: "apps" }, owner, deadline),
  observe: (app, screenshot, owner, deadline) => request({ type: "observe", app, screenshot }, owner, deadline),
  act: (app, actions, screenshot, owner, deadline) =>
    request({ type: "act", app, actions, screenshot, pace: paced }, owner, deadline),
};
