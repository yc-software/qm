import { formatMessage, type Locale } from "../../chassis/src/locale.ts";

const en = {
  language: "Language",
  english: "English",
  japanese: "日本語",
  navigation: "Navigation",
  signOut: "Sign out",
  loading: "Loading…",
  commonFailure: "Something went wrong. Try again.",
};

const ja: Record<keyof typeof en, string> = {
  language: "表示言語",
  english: "English",
  japanese: "日本語",
  navigation: "ナビゲーション",
  signOut: "サインアウト",
  loading: "読み込み中…",
  commonFailure: "問題が発生しました。もう一度お試しください。",
};

export const WEB_MESSAGES = { en, ja } as const;
export type WebMessageKey = keyof typeof en;

export function webMessage(
  selected: Locale,
  key: WebMessageKey,
  values?: Readonly<Record<string, string | number>>,
): string {
  return formatMessage(WEB_MESSAGES[selected][key], values);
}
