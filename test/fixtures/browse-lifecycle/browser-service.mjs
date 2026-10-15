import { EventEmitter } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { Browser, config } from "./playwright.mjs";

export async function startBrowserService(cdpUrl) {
  if (cdpUrl !== "ws://fixture.invalid/browser") throw new Error("Unexpected cloud endpoint");
  if (config.serviceError) throw new Error(config.serviceError);
  const service = new EventEmitter();
  service.endpoint = new URL("./fixture-config.json", import.meta.url).href;
  service.browser = new Browser();
  let failure;
  service.getError = () => failure;
  const timer = setInterval(() => {
    if (!existsSync(config.disconnect)) return;
    if (config.disconnectError)
      failure = Object.assign(new Error(`${config.disconnectError} ${cdpUrl} ${process.env.BROWSER_USE_API_KEY}`), {
        code: "WS_ERR_INVALID_OPCODE",
        cause: new Error("inner wire failure"),
      });
    service.emit("disconnected", failure);
  }, 20);
  service.close = async () => {
    clearInterval(timer);
    appendFileSync(config.events, `${JSON.stringify({ method: "service.close" })}\n`);
  };
  return service;
}
