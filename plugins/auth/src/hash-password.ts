import { pathToFileURL } from "node:url";
import { hashPassword, passwordProblem } from "./password.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(label);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export async function main(argv: string[]): Promise<string> {
  const email = argv
    .find((arg) => !arg.startsWith("-"))
    ?.trim()
    .toLowerCase();
  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden("Password: ");
    const again = await promptHidden("Again: ");
    if (password !== again) throw new Error("passwords did not match");
  } else {
    password = (await readStdin()).replace(/\r?\n$/, "");
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  return email ? `${email}:${hash}` : hash;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (line) => {
      process.stdout.write(`${line}\n`);
    },
    (err: unknown) => {
      process.stderr.write(`hash-password: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
