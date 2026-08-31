import type { QmAnalyticsNativeCard } from "../types.ts";

function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mrkdwn(value: string): Record<string, unknown> {
  return { type: "mrkdwn", text: escapeMrkdwn(value).slice(0, 2_900) };
}

export function analyticsNativeCardBlocks(card: QmAnalyticsNativeCard): Array<Record<string, unknown>> {
  const findings = card.findings.length
    ? card.findings.map((finding) => `• ${finding.text} _(${finding.source}, ${finding.confidence})_`).join("\n")
    : "• No supported finding was returned. Do not infer one.";
  return [
    { type: "header", text: { type: "plain_text", text: card.heading.slice(0, 150) } },
    { type: "section", text: mrkdwn(`*Question*\n${card.question}`) },
    { type: "section", text: mrkdwn(`*Findings*\n${findings}`) },
    ...(card.confidenceNotes.length
      ? [{ type: "context", elements: [mrkdwn(`*Confidence notes:* ${card.confidenceNotes.join(" · ")}`)] }]
      : []),
    { type: "section", text: mrkdwn(`*Next step*\n${card.nextStep}`) },
    ...(card.proposedActions.length
      ? [
          {
            type: "section",
            text: mrkdwn(
              `*Proposed actions (not executed)*\n${card.proposedActions.map((item) => `• ${item}`).join("\n")}`,
            ),
          },
        ]
      : []),
    { type: "context", elements: [mrkdwn(`Receipt: \`${card.receiptId}\``)] },
  ];
}
