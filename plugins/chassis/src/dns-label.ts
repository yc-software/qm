export const DNS_LABEL_MAX = 63;

const LABEL_CHARS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isDnsLabel(label: string): boolean {
  return label.length <= DNS_LABEL_MAX && LABEL_CHARS.test(label);
}

export function isDnsName(name: string): boolean {
  return name.split(".").every(isDnsLabel);
}
