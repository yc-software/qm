export const probedCommand = (command: string): string =>
  /^\(eval '([^]*?)'\)\n__qm_rc=/.exec(command)?.[1]?.replaceAll(`'\\''`, "'") ?? command;
