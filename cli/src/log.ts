const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = (s: string): string => paint("1", s);
export const dim = (s: string): string => paint("2", s);
const green = (s: string): string => paint("32", s);
const yellow = (s: string): string => paint("33", s);
export const red = (s: string): string => paint("31", s);

export class CliError extends Error {
  clause: string | undefined;
  problems: { clause: string; message: string }[] | undefined;
  constructor(
    message: string,
    opts?: ErrorOptions & { clause?: string; problems?: { clause: string; message: string }[] },
  ) {
    super(message, opts);
    this.clause = opts?.clause;
    this.problems = opts?.problems;
  }
}

export const note = (msg = ""): void => console.log(msg);
export const step = (msg: string): void => console.log(`${dim("·")} ${msg}`);
export const ok = (msg: string): void => console.log(`${green("✓")} ${msg}`);
export const warn = (msg: string): void => console.warn(`${yellow("!")} ${msg}`);

export function die(msg: string): never {
  throw new CliError(msg);
}

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function header(title: string): void {
  console.log(`\n${bold(`=== ${title} ===`)}`);
}
