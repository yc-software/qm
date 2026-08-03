import { formatMessage, type Locale } from "../../chassis/src/locale.ts";

const en = {
  "language.label": "Language",
  "language.english": "English",
  "language.japanese": "日本語",
  "language.change": "Change language",
  "signIn.title": "Sign in",
  "signIn.heading": "Sign in to {brand}",
  "signIn.message": "Enter your work email and we'll send you a one-time sign-in link.",
  "signIn.tryAgain": "Try again",
  "signIn.emailLabel": "Email address",
  "signIn.emailPlaceholder": "you@example.com",
  "signIn.submit": "Email me a sign-in link",
  "signIn.help": "Only addresses your administrator has allowed can sign in.",
  "sent.title": "Check your email",
  "sent.heading": "Check your email",
  "sent.message":
    "If that address can sign in, a one-time link is on its way. Open it in this browser — it works once and expires in {minutes} minutes.",
  "sent.help": "Nothing after a minute or two? Check spam, then ask your administrator whether the address is allowed.",
  "confirm.title": "Finish signing in",
  "confirm.heading": "Finish signing in to {brand}",
  "confirm.message":
    "Confirm below to complete sign-in. Your link is spent the moment you confirm, so do it in the browser you want to be signed in to.",
  "confirm.missingTitle": "Nothing to confirm",
  "confirm.missingBody":
    "This page did not receive a sign-in link. Open the link from your email directly, in a browser with JavaScript enabled, or ask for a fresh one.",
  "confirm.javascriptTitle": "JavaScript required",
  "confirm.javascriptBody":
    "The last step of sign-in reads your link out of the page address so it never reaches a server log. Enable JavaScript for this page, then reopen the link.",
  "confirm.submit": "Sign in",
  "confirm.help": "Didn't ask to sign in? Close this page — nothing happens until you confirm.",
  "problem.title": "Sign-in problem",
  "problem.details": "Details",
  "problem.retry": "Request a new sign-in link",
  "problem.help": "If this keeps happening, contact your administrator.",
  "error.invalidRequestHeading": "This sign-in link isn't valid",
  "error.invalidRequestMessage": "Start again from the page you were trying to reach.",
  "error.unknownApplication": "This sign-in request is for an unknown application.",
  "error.unregisteredRedirect": "This sign-in request would return you to an address that is not registered.",
  "error.authorizationCodeOnly": "Only the authorization-code flow is supported.",
  "error.pkceS256Required": "This sign-in request must use PKCE with S256.",
  "error.malformedPkce": "This sign-in request carries a malformed PKCE challenge.",
  "error.missingState": "This sign-in request is missing its state.",
  "error.missingNonce": "This sign-in request is missing its nonce.",
  "error.openidRequired": "This sign-in request must ask for the openid scope.",
  "error.failedHeading": "That didn't work",
  "error.formTooLarge": "The sign-in form sent more data than we accept.",
  "error.expiredPageHeading": "This sign-in page expired",
  "error.expiredPageMessage":
    "Sign-in pages are only valid for a short while. Start again from the page you were trying to reach.",
  "error.invalidEmail": "That doesn't look like an email address.",
  "error.staleLinkHeading": "This sign-in link no longer works",
  "error.staleLinkMessage": "Sign-in links work once and expire quickly. Request a fresh one and open it right away.",
  "error.changedConfigMessage": "The sign-in configuration changed after this link was sent. Start again.",
  "error.disallowedHeading": "This address can't sign in",
  "error.disallowedMessage": "Your administrator has not allowed this email address.",
  "mail.subject": "Sign in to {brand}",
  "mail.openInstruction": "Open this link to finish signing in:",
  "mail.expiry": "The link works once and expires in {minutes} minutes. Open it in the browser you started from.",
  "mail.ignore": "If you did not ask to sign in, ignore this message — nothing happens until you confirm.",
  "mail.htmlInstruction":
    "Use the button below to finish signing in. It works once, expires in {minutes} minutes, and should be opened in the browser you started from.",
  "mail.button": "Sign in",
  "mail.paste": "Or paste this address into your browser:",
} as const;

type AuthMessageKey = keyof typeof en;

const ja: Record<AuthMessageKey, string> = {
  "language.label": "言語",
  "language.english": "English",
  "language.japanese": "日本語",
  "language.change": "言語を変更",
  "signIn.title": "サインイン",
  "signIn.heading": "{brand}にサインイン",
  "signIn.message": "仕事用メールアドレスを入力すると、1回限りのサインインリンクを送信します。",
  "signIn.tryAgain": "もう一度お試しください",
  "signIn.emailLabel": "メールアドレス",
  "signIn.emailPlaceholder": "you@example.com",
  "signIn.submit": "サインインリンクをメールで受け取る",
  "signIn.help": "管理者が許可したメールアドレスのみサインインできます。",
  "sent.title": "メールを確認してください",
  "sent.heading": "メールを確認してください",
  "sent.message":
    "このメールアドレスでサインインできる場合、1回限りのリンクを送信しました。操作中のブラウザで開いてください。リンクの有効期限は{minutes}分です。",
  "sent.help":
    "数分待っても届かない場合は迷惑メールを確認し、管理者にメールアドレスが許可されているか確認してください。",
  "confirm.title": "サインインを完了",
  "confirm.heading": "{brand}へのサインインを完了",
  "confirm.message":
    "下のボタンを押すとサインインが完了します。確認した時点でリンクは使用済みになるため、サインインに使うブラウザで操作してください。",
  "confirm.missingTitle": "確認できるリンクがありません",
  "confirm.missingBody":
    "このページにサインインリンクが渡されませんでした。JavaScriptが有効なブラウザでメールのリンクを直接開くか、新しいリンクを取得してください。",
  "confirm.javascriptTitle": "JavaScriptが必要です",
  "confirm.javascriptBody":
    "サーバーログにリンクを残さないため、最後の手順ではページのアドレスからリンクを読み取ります。このページでJavaScriptを有効にして、リンクをもう一度開いてください。",
  "confirm.submit": "サインイン",
  "confirm.help": "サインインを依頼していない場合は、このページを閉じてください。確認するまで何も実行されません。",
  "problem.title": "サインインで問題が発生しました",
  "problem.details": "詳細",
  "problem.retry": "新しいサインインリンクを取得",
  "problem.help": "問題が解消しない場合は、管理者に連絡してください。",
  "error.invalidRequestHeading": "このサインインリクエストは無効です",
  "error.invalidRequestMessage": "アクセスしようとしていたページから、もう一度サインインしてください。",
  "error.unknownApplication": "このサインインリクエストのアプリケーションは認識されていません。",
  "error.unregisteredRedirect": "このサインインリクエストの戻り先は登録されていません。",
  "error.authorizationCodeOnly": "認可コードフローのみ利用できます。",
  "error.pkceS256Required": "このサインインリクエストではS256方式のPKCEが必要です。",
  "error.malformedPkce": "このサインインリクエストのPKCEチャレンジが正しくありません。",
  "error.missingState": "このサインインリクエストにstateがありません。",
  "error.missingNonce": "このサインインリクエストにnonceがありません。",
  "error.openidRequired": "このサインインリクエストにはopenidスコープが必要です。",
  "error.failedHeading": "処理できませんでした",
  "error.formTooLarge": "サインインフォームから送信されたデータが上限を超えています。",
  "error.expiredPageHeading": "このサインインページの有効期限が切れました",
  "error.expiredPageMessage":
    "サインインページの有効期間は短く設定されています。アクセスしようとしていたページから、もう一度サインインしてください。",
  "error.invalidEmail": "メールアドレスの形式を確認してください。",
  "error.staleLinkHeading": "このサインインリンクは使用できません",
  "error.staleLinkMessage":
    "サインインリンクは1回限りで、有効期間も短く設定されています。新しいリンクを取得して、すぐに開いてください。",
  "error.changedConfigMessage": "リンクの送信後にサインイン設定が変更されました。最初からやり直してください。",
  "error.disallowedHeading": "このメールアドレスではサインインできません",
  "error.disallowedMessage": "管理者はこのメールアドレスを許可していません。",
  "mail.subject": "{brand}にサインイン",
  "mail.openInstruction": "次のリンクを開いてサインインを完了してください。",
  "mail.expiry":
    "リンクは1回限り有効で、{minutes}分後に期限切れになります。サインインを開始したブラウザで開いてください。",
  "mail.ignore": "サインインを依頼していない場合は、このメールを無視してください。確認するまで何も実行されません。",
  "mail.htmlInstruction":
    "下のボタンを押してサインインを完了してください。リンクは1回限り有効で、{minutes}分後に期限切れになります。サインインを開始したブラウザで開いてください。",
  "mail.button": "サインイン",
  "mail.paste": "または、次のアドレスをブラウザに貼り付けてください。",
};

export const AUTH_MESSAGES: Record<Locale, Record<AuthMessageKey, string>> = { en, ja };

export function authMessage(locale: Locale, key: AuthMessageKey, values?: Record<string, unknown>): string {
  return formatMessage(AUTH_MESSAGES[locale][key], values);
}

export type { AuthMessageKey };
