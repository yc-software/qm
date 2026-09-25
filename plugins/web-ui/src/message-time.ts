export function formatMessageTime(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date(now);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);
  const options: Intl.DateTimeFormatOptions =
    date >= weekStart && date < today
      ? { weekday: "long" }
      : {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
        };
  return `${date.toLocaleDateString([], options)} ${time}`;
}
