import { loadProtocolFile } from "../../resolution/prompt-vars.ts";
import { USER_REPLY_RULES_MD } from "./turn-prompt.ts";

export const APP_EDIT_FRAME_MD = loadProtocolFile("mode-app-edit");

export const APP_EDIT_TOOLS = ["app_files", "apps", "execute", "skills", "files", "history"];

export function appEditPromptBody(instructions: string, persona: string): string {
  return [instructions, persona, USER_REPLY_RULES_MD].filter(Boolean).join("\n\n");
}
