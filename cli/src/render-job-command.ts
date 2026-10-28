export function renderJobCommand(script: string, interpreter: string): string {
  const separator = "${IFS}";
  const decode = ["printf", "%s", Buffer.from(script).toString("base64")].join(separator);
  return `/bin/sh -c ${decode}|${["base64", "-d"].join(separator)}|${interpreter.split(" ").join(separator)}`;
}
