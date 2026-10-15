import { start } from "node:repl";
import { writeSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { PassThrough, Writable } from "node:stream";
import { inspect } from "node:util";
import { createBrowserClient } from "./browser-client.mjs";
import { formatBrowserError } from "./browser-errors.mjs";
const send = (message) => process.send?.(message);
const { chromium } = await import(process.argv[3]);
const connection = await chromium.connect(process.argv[2]);
const browser = await createBrowserClient(connection);
let output = "";
const stream = new Writable({
  write(chunk, _encoding, done) {
    output = (output + chunk.toString()).slice(0, 10_000);
    done();
  },
});
const repl = start({ input: new PassThrough(), output: stream, terminal: false, prompt: "", useGlobal: false });
repl.context.browser = browser;
const tabs = await browser.tabs.list();
repl.context.tab = tabs.length ? await browser.tabs.get(tabs.at(-1).id) : await browser.tabs.new();
repl.context.console = new console.Console(stream, stream);
let active;
const invocation = new AsyncLocalStorage();
function fatal(error) {
  const message =
    `Unhandled asynchronous error; browser stopped: ${formatBrowserError(error, [process.argv[2]])}`.slice(0, 10_000);
  try {
    writeSync(2, message + "\n");
    send({ type: "fatal", error: message });
  } finally {
    process.exit(1);
  }
}
process.on("uncaughtExceptionMonitor", fatal);
function complete(id, error, result, failed = error !== null && error !== undefined) {
  if (active !== id) return;
  active = null;
  let rendered = null;
  if (typeof result === "string") rendered = result;
  else if (result !== undefined) rendered = inspect(result, { depth: 6, maxArrayLength: 100, maxStringLength: 10_000 });
  send({
    type: "result",
    id,
    error: failed ? formatBrowserError(error, [process.argv[2]]) : undefined,
    result: rendered,
    output,
  });
}
repl._domain.prependListener("error", (error) => {
  const id = invocation.getStore();
  if (!id || id !== active || error?.domainThrown || error?.domainEmitter) return fatal(error);
  complete(id, error, undefined, true);
});
process.on("message", (message) => {
  if (message.type === "js") {
    output = "";
    active = message.id;
    invocation.run(message.id, () =>
      repl.eval(message.code + "\n", repl.context, "browser-js", (error, result) =>
        complete(message.id, error, result),
      ),
    );
  }
});
process.on("disconnect", () => process.exit(0));

send({ type: "ready" });
