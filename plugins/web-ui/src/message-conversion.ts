import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { Attachment, UserMessageWithAttachments } from "@earendil-works/pi-web-ui";

export function attachmentContent(attachments: readonly Attachment[]): Array<TextContent | ImageContent> {
  const content: Array<TextContent | ImageContent> = [];
  for (const attachment of attachments) {
    if (attachment.type === "image") {
      content.push({ type: "image", data: attachment.content, mimeType: attachment.mimeType });
    } else if (attachment.type === "document" && attachment.extractedText) {
      content.push({
        type: "text",
        text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
      });
    }
  }
  return content;
}

function hasAttachments(message: AgentMessage): message is UserMessageWithAttachments {
  return message.role === "user-with-attachments";
}

export function convertMessagesToLlm(messages: AgentMessage[]): Message[] {
  const converted: Message[] = [];
  for (const message of messages) {
    if (hasAttachments(message)) {
      const content =
        typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : [...message.content];
      if (message.attachments) content.push(...attachmentContent(message.attachments));
      converted.push({ role: "user", content, timestamp: message.timestamp });
    } else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      converted.push(message);
    }
  }
  return converted;
}
