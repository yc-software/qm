import { loadProtocolFile } from "../../resolution/prompt-vars.ts";
import { USER_REPLY_RULES_MD } from "./turn-prompt.ts";

const APP_EDIT_FRAME_MD = loadProtocolFile("mode-app-edit");

const APP_EDIT_TOOLS = ["app_files", "apps", "execute", "skills", "files", "history"];

export function appEditTurnPolicy(appEditChat: boolean) {
  if (!appEditChat) return null;
  return {
    frameMd: APP_EDIT_FRAME_MD,
    onlyTools: APP_EDIT_TOOLS,
    body: (instructions: string, persona: string) =>
      [instructions, persona, USER_REPLY_RULES_MD].filter(Boolean).join("\n\n"),
  };
}
