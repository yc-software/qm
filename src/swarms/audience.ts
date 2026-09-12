import { spawn } from "node:child_process";

let running = 0;

function jqUnicode(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed();
  if (Array.isArray(value)) return value.map(jqUnicode);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key.toWellFormed(), jqUnicode(child)]));
  return value;
}

export async function selectAudience(
  filter: string,
  peers: Array<{ id: string; context: unknown }>,
): Promise<string[]> {
  if (!filter || Buffer.byteLength(filter) > 2_048 || /\b(?:import|include|module)\b/.test(filter))
    throw new Error("invalid audience filter");
  if (peers.length > 32 || running >= 4) throw new Error("audience evaluation capacity exceeded");
  const input = peers.map(({ id, context }) => ({
    ...(context && typeof context === "object" && !Array.isArray(context) ? context : {}),
    context,
    id,
  }));
  const encoded = JSON.stringify(jqUnicode(input));
  if (Buffer.byteLength(encoded) > 512_000) throw new Error("audience input too large");
  running++;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "prlimit",
        ["--as=134217728", "--cpu=1", "--nofile=16", "--", "jq", "-c", "-L", "/dev/null", `(${filter}\n)`],
        { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] },
      );
      let result = "";
      let failed = false;
      const fail = () => {
        failed = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(fail, 500);
      child.stdout.on("data", (data: Buffer) => {
        if (Buffer.byteLength(result) + data.length > 512_000) fail();
        else result += data.toString();
      });
      child.stderr.resume();
      child.stdin.on("error", fail);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("audience evaluator unavailable"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed || code !== 0) reject(new Error("invalid or resource-exhausting audience filter"));
        else resolve(result);
      });
      child.stdin.end(encoded);
    });
    const eligible = new Set(peers.map((peer) => peer.id));
    const selected = new Set<string>();
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const value: unknown = JSON.parse(line);
      const id = value && typeof value === "object" && "id" in value ? value.id : undefined;
      if (typeof id !== "string" || !eligible.has(id)) throw new Error("audience must emit eligible peer objects");
      selected.add(id);
    }
    return [...selected];
  } finally {
    running--;
  }
}
