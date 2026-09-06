import { pathToFileURL } from "node:url";
import { sleep } from "../src/util/async.ts";
import { errMessage } from "../src/util/errors.ts";

const TYPE_EMOJI: Record<string, string> = {
  feat: "✨",
  fix: "🔧",
  perf: "⚡",
  refactor: "🧹",
  docs: "📝",
  test: "🧪",
  deps: "📦",
  chore: "⚙️",
  ci: "⚙️",
  build: "⚙️",
  style: "🎨",
  revert: "⏪",
};

const DEFAULT_EMOJI = "🚀";

function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function emojiFor(subject: string): string {
  const type = /^([a-z]+)(?:\([^)]*\))?!?: /.exec(subject)?.[1];
  return (type && TYPE_EMOJI[type]) || DEFAULT_EMOJI;
}

export interface DeployNoticeInput {
  subject: string;
  repo: string;
  sha: string;
}

export function formatDeployNotice({ subject, repo, sha }: DeployNoticeInput): string {
  const trimmed = subject.trim();
  const pr = /\s*\(#(\d+)\)$/.exec(trimmed);
  const body = escapeSlack(pr ? trimmed.slice(0, pr.index) : trimmed);
  const link = pr
    ? `<https://github.com/${repo}/pull/${pr[1]}|#${pr[1]}>`
    : `<https://github.com/${repo}/commit/${sha}|${sha.slice(0, 7)}>`;
  return `${emojiFor(trimmed)} ${body} ${link}`;
}

export async function postDeployNotice(url: string, text: string): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleep(2000 * (attempt - 1));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) return;
      lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (err) {
      lastError = errMessage(err);
    }
    console.error(`deploy notice attempt ${attempt} failed: ${lastError}`);
  }
  throw new Error(`could not post the deploy notice to Slack after 3 attempts: ${lastError}`);
}

async function main(): Promise<void> {
  const url = process.env.SLACK_DEPLOY_WEBHOOK_URL;
  const subject = process.env.DEPLOY_SUBJECT;
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!url || !subject || !repo || !sha) {
    throw new Error("SLACK_DEPLOY_WEBHOOK_URL, DEPLOY_SUBJECT, GITHUB_REPOSITORY and GITHUB_SHA are all required");
  }
  const text = formatDeployNotice({ subject, repo, sha });
  await postDeployNotice(url, text);
  console.log(`posted: ${text}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
