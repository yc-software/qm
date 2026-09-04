import { createServer } from "node:net";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);

const port = Number(args.port ?? 0);
const readyDelay = Number(args.readyDelay ?? 0);
const crashAfter = Number(args.crashAfter ?? 0);
const ignoreTerm = args.ignoreTerm === "1";

if (ignoreTerm) process.on("SIGTERM", () => console.log("ignoring SIGTERM"));

setTimeout(() => {
  if (port) {
    const server = createServer(() => {});
    server.listen(port, "127.0.0.1", () => console.log(`fake-child ready on :${port}`));
  } else {
    console.log("fake-child ready");
  }
  if (crashAfter > 0) {
    setTimeout(() => {
      console.log("fake-child crashing");
      process.exit(3);
    }, crashAfter);
  }
}, readyDelay);
