export interface AppNotices {
  list: string;
  detail: { id: string; text: string } | null;
}

export function withAppListNotice(notices: AppNotices, list: string): AppNotices {
  return { ...notices, list };
}

export function withAppDetailNotice(notices: AppNotices, id: string, text: string): AppNotices {
  return { ...notices, detail: { id, text } };
}

export function withoutAppDetailNotice(notices: AppNotices): AppNotices {
  return { ...notices, detail: null };
}
