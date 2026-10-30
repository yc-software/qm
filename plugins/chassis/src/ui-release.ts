export const UI_PROTOCOL = 1;
export const UI_VERSION_HEADER = "x-qm-ui-version";
export const UI_RELEASE_META = "qm-ui-release";
export const UI_CHANNEL_COOKIE = "qm_ui_channel";
export const UI_OUTDATED_EVENT = "webui:outdated";

export const isUiChannel = (value: string): boolean => /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);

export function uiVersion(release: string | null | undefined): string {
  return release ? `${UI_PROTOCOL}+${release}` : String(UI_PROTOCOL);
}
