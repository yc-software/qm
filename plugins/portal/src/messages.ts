import { formatMessage, type Locale } from "../../chassis/src/locale.ts";

const en = {
  "language.label": "Language",
  "language.english": "English",
  "language.japanese": "日本語",
  "signIn.title": "Sign-in failed",
  "signIn.heading": "We couldn't sign you in",
  "signIn.message": "Your sign-in didn't complete. This is usually temporary — trying again resolves most cases.",
  "signIn.details": "Details",
  "signIn.retry": "Try signing in again",
  "signIn.back": "Back to start",
  "signIn.help": "Still stuck? Make sure you're a member of the approved workspace, then contact your admin.",
  "signIn.identityProvider": "identity provider returned: {error}",
  "signIn.expired": "login session expired — please try again",
  "signIn.invalidState": "invalid login state",
  "signIn.alreadyUsed": "login already used — please try again",
  "admin.deniedTitle": "No admin access",
  "admin.deniedHeading": "You don't have admin access",
  "admin.deniedMessage":
    "The Admin area is limited to governance admins. Your account is signed in and verified — it just isn't granted admin rights.",
  "admin.signedInAs": "Signed in as",
  "admin.deniedNote":
    "Admin rights come from your organization's admin grants. If you need access, ask an existing admin to grant it.",
  "admin.backToSurfaces": "Back to your surfaces",
  "admin.tryAgain": "Try again",
  "admin.openAssistant": "Open the assistant instead",
  "admin.deniedHelp": "You can keep using every surface available to your account.",
  "admin.unavailableTitle": "Admin temporarily unavailable",
  "admin.unavailableHeading": "Admin is temporarily unavailable",
  "admin.unavailableMessage":
    "We couldn't check your admin access right now. This is usually temporary — trying again resolves most cases.",
  "admin.unavailableHelp": "If this keeps happening, the admin service may be down — contact your admin.",
  "setup.title": "Not set up yet",
  "setup.heading": "This deployment isn't set up yet",
  "setup.message":
    "An admin still needs to finish setup by adding a model API key. Until then the assistant can't answer.",
  "setup.tryAgain": "Try again",
  "setup.help": "Ask your admin to complete onboarding in the Admin area.",
  "connect.errorTitle": "Can't connect",
  "connect.serviceUnavailable": "We couldn't reach the connection service. Please try the link again in a moment.",
  "connect.serviceUnavailableShort": "We couldn't reach the connection service. Please try again in a moment.",
  "connect.unexpected": "The connection service returned an unexpected response.",
  "connect.expired": "This connect link has expired — ask the agent for a fresh one.",
  "connect.invalid": "This connect link is invalid or was already used — ask the agent for a fresh one.",
  "connect.startFailed": "We couldn't start the connection. This app may not be configured.",
  "connect.alreadyTitle": "You've already connected {provider}",
  "connect.alreadyBody":
    "This link was meant for a different teammate, and your {provider} is already connected — there's nothing to do here.",
  "connect.manage": "Manage your connections",
  "connect.wrongTitle": "This link was for someone else",
  "connect.wrongBody":
    "This connect link was created for a different teammate. Want to connect your own {provider} instead?",
  "connect.connectMine": "Connect my {provider}",
  "connect.appFallback": "this app",
  "playground.busyTitle": "Playground is busy",
  "playground.busyHeading": "The playground is busy",
  "playground.busyMessage":
    "We couldn't start a fresh playground session for you right now. Waiting a little while and reloading resolves most cases.",
  "playground.tryAgain": "Try again",
  "playground.busyHelp": "Playground sessions are limited per visitor to keep the demo responsive for everyone.",
  "playground.restrictedTitle": "Not available in the playground",
  "playground.restrictedHeading": "Not available in the playground",
  "playground.restrictedMessage":
    "Connecting accounts and dropping secrets are disabled for anonymous playground sessions — clearing your cookie would orphan real credentials.",
  "playground.back": "Back to the playground",
  "playground.restrictedHelp": "Sign in with a real account at /auth/login to use this link.",
  "secret.unavailableTitle": "Credential service unavailable",
  "secret.unavailableBody": "Try the link again in a moment.",
} as const;

type PortalMessageKey = keyof typeof en;

const ja: Record<PortalMessageKey, string> = {
  "language.label": "言語",
  "language.english": "English",
  "language.japanese": "日本語",
  "signIn.title": "サインイン失敗",
  "signIn.heading": "サインインできませんでした",
  "signIn.message": "サインインが完了しませんでした。一時的な問題の場合が多いため、もう一度お試しください。",
  "signIn.details": "詳細",
  "signIn.retry": "もう一度サインイン",
  "signIn.back": "最初の画面に戻る",
  "signIn.help": "解決しない場合は、許可されたワークスペースのメンバーであることを確認し、管理者へ連絡してください。",
  "signIn.identityProvider": "認証サービスからエラーが返されました: {error}",
  "signIn.expired": "サインイン操作の有効期限が切れました。もう一度お試しください。",
  "signIn.invalidState": "サインインの状態を確認できませんでした。",
  "signIn.alreadyUsed": "このサインイン操作は使用済みです。もう一度お試しください。",
  "admin.deniedTitle": "管理権限がありません",
  "admin.deniedHeading": "管理画面を利用できません",
  "admin.deniedMessage":
    "管理画面は運用管理者のみ利用できます。サインインは完了していますが、管理権限が付与されていません。",
  "admin.signedInAs": "サインイン中",
  "admin.deniedNote": "管理権限は組織の管理者設定で付与されます。必要な場合は、既存の管理者へ依頼してください。",
  "admin.backToSurfaces": "利用できる画面に戻る",
  "admin.tryAgain": "もう一度試す",
  "admin.openAssistant": "アシスタントを開く",
  "admin.deniedHelp": "権限のある他の画面は引き続き利用できます。",
  "admin.unavailableTitle": "管理画面を利用できません",
  "admin.unavailableHeading": "管理画面を一時的に利用できません",
  "admin.unavailableMessage":
    "現在、管理権限を確認できませんでした。一時的な問題の場合が多いため、もう一度お試しください。",
  "admin.unavailableHelp": "解決しない場合は管理サービスが停止している可能性があるため、管理者へ連絡してください。",
  "setup.title": "初期設定が必要です",
  "setup.heading": "初期設定が完了していません",
  "setup.message":
    "管理者がモデルのAPIキーを登録して初期設定を完了する必要があります。完了するまでアシスタントは回答できません。",
  "setup.tryAgain": "もう一度試す",
  "setup.help": "管理者に、管理画面で初期設定を完了するよう依頼してください。",
  "connect.errorTitle": "接続できません",
  "connect.serviceUnavailable": "接続サービスに到達できませんでした。しばらくしてからリンクをもう一度お試しください。",
  "connect.serviceUnavailableShort": "接続サービスに到達できませんでした。しばらくしてからもう一度お試しください。",
  "connect.unexpected": "接続サービスから予期しない応答が返されました。",
  "connect.expired": "接続リンクの有効期限が切れています。エージェントに新しいリンクを発行するよう依頼してください。",
  "connect.invalid":
    "この接続リンクは無効または使用済みです。エージェントに新しいリンクを発行するよう依頼してください。",
  "connect.startFailed": "接続を開始できませんでした。このアプリは設定されていない可能性があります。",
  "connect.alreadyTitle": "{provider}は接続済みです",
  "connect.alreadyBody":
    "このリンクは別の利用者向けですが、あなたの{provider}はすでに接続済みです。必要な操作はありません。",
  "connect.manage": "接続を管理",
  "connect.wrongTitle": "このリンクは別の利用者向けです",
  "connect.wrongBody": "この接続リンクは別の利用者向けに作成されています。自分の{provider}を接続しますか？",
  "connect.connectMine": "自分の{provider}を接続",
  "connect.appFallback": "このアプリ",
  "playground.busyTitle": "Playgroundは混み合っています",
  "playground.busyHeading": "Playgroundは混み合っています",
  "playground.busyMessage":
    "現在、新しいPlaygroundセッションを開始できません。しばらく待ってから再読み込みしてください。",
  "playground.tryAgain": "もう一度試す",
  "playground.busyHelp": "すべての利用者が快適に試せるよう、利用者ごとにPlaygroundセッション数を制限しています。",
  "playground.restrictedTitle": "Playgroundでは利用できません",
  "playground.restrictedHeading": "Playgroundでは利用できません",
  "playground.restrictedMessage": "匿名のPlaygroundセッションでは、アカウント接続と認証情報の登録を利用できません。",
  "playground.back": "Playgroundに戻る",
  "playground.restrictedHelp": "このリンクを使うには、/auth/loginから通常のアカウントでサインインしてください。",
  "secret.unavailableTitle": "認証情報サービスを利用できません",
  "secret.unavailableBody": "しばらくしてからリンクをもう一度お試しください。",
};

export const PORTAL_MESSAGES: Record<Locale, Record<PortalMessageKey, string>> = { en, ja };

export function portalMessage(locale: Locale, key: PortalMessageKey, values?: Record<string, unknown>): string {
  return formatMessage(PORTAL_MESSAGES[locale][key], values);
}

export type { PortalMessageKey };
