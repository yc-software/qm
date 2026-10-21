import emojiSource from "emoji-datasource/emoji.json" with { type: "json" };
import { emojiTable } from "./emoji-source.ts";

export const EMOJI_TABLE = emojiTable(emojiSource);
