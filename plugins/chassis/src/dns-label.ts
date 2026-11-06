export const DNS_LABEL_MAX = 63;

const LABEL_CHARS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isDnsLabel(label: string): boolean {
  return label.length <= DNS_LABEL_MAX && LABEL_CHARS.test(label);
}

export function isDnsName(name: string): boolean {
  return name.split(".").every(isDnsLabel);
}

export const APP_HANDLE_MIN = 2;
export const APP_HANDLE_MAX = DNS_LABEL_MAX - "-a".length;
export const APP_HANDLE_CHARS = `${APP_HANDLE_MIN}–${APP_HANDLE_MAX} lowercase letters or digits, with no hyphens`;

export function isAppHandleShape(handle: string): boolean {
  return handle.length >= APP_HANDLE_MIN && handle.length <= APP_HANDLE_MAX && /^[a-z0-9]+$/.test(handle);
}
