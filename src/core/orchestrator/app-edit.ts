import { loadProtocolFile } from "../../resolution/prompt-vars.ts";
import { USER_REPLY_RULES_MD } from "./turn-prompt.ts";

const APP_EDIT_FRAME_MD = loadProtocolFile("mode-app-edit");

export function appEditTurnPolicy(appEditChat: boolean) {
  if (!appEditChat) return null;
  return {
    frameMd: APP_EDIT_FRAME_MD,
    body: (basePrompt: string) => [basePrompt, USER_REPLY_RULES_MD].filter(Boolean).join("\n\n"),
  };
}
