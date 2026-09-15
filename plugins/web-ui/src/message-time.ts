import { format } from "date-fns";

export function formatMessageTime(ms: number): string {
  try {
    return format(ms, "yyyy-MM-dd HH:mm");
  } catch {
    return "";
  }
}
