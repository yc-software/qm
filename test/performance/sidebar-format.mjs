export function sidebarSurface(row) {
  if (row.threadRef.startsWith("web:")) return "web";
  if (row.threadRef.startsWith("dm:") || row.threadRef.startsWith("ch:")) return "slack";
  if (row.threadRef.startsWith("agent:main:subagent:") && row.surface) return row.surface;
  return "core";
}

const compareIdentity = (a, b) => (a < b ? -1 : Number(a !== b));

export function sidebarFormatter(contexts, profile) {
  const activity = (row) => row.lastActivityAt ?? row.createdAt;
  const ordered = (rows, identity = (row) => row.id, at = activity) =>
    [...rows].sort(
      (a, b) =>
        at(b) - at(a) || (profile.transport === "navigation-post" ? compareIdentity(identity(a), identity(b)) : 0),
    );
  const isWeb = (row) =>
    row.threadRef.startsWith("web:") || (row.threadRef.startsWith("agent:main:subagent:") && row.surface === "web");
  const byScope = new Map(contexts.map((row) => [row.scopeId, row]));
  const projectName = (row) => byScope.get(row.scopeId)?.project?.name;
  const dmNames = (value) => {
    const raw = (value ?? "").trim().replace(/^#/, "");
    return raw.startsWith("mpdm-")
      ? raw
          .slice(5)
          .split("--")
          .map((part) => part.trim().replace(/-\d+$/u, "").replace(/-/g, " ").trim())
          .filter(Boolean)
      : raw
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
  };
  const labeled = (row) => {
    const names = dmNames(row.channelName);
    let fallback = "Direct message";
    if (projectName(row)) fallback = projectName(row);
    else if (isWeb(row)) fallback = "Web chat";
    else if (row.type === "channel")
      fallback = row.channelName?.trim() ? `#${row.channelName.replace(/^#/, "")}` : "Channel";
    else if (row.type === "group") fallback = names.length ? names.join(", ") : (row.channelName?.trim() ?? "Group DM");
    let title = fallback;
    if (row.title?.trim()) title = row.title;
    else if (!projectName(row) && row.type === "group" && names.length) title = `${names.length} ${names.join(", ")}`;
    const groupedFallback = isWeb(row) ? "Web chat" : "New chat";
    return {
      id: row.id,
      title,
      groupedTitle: row.title?.trim() ? row.title : groupedFallback,
      scopeId: row.scopeId,
    };
  };
  const groupName = (context) => {
    if (context.project) return context.project.name.trim() || null;
    if (context.kind === "personal") return "Personal";
    if (context.scopeId.startsWith("channel:"))
      return context.name ? `#${context.name.replace(/^#/, "")}` : "Shared channel";
    if (context.scopeId.startsWith("group:")) {
      const names = dmNames(context.name);
      return names.length ? names.join(", ") : (context.name ?? "Group");
    }
    return null;
  };
  return { activity, ordered, isWeb, labeled, groupName };
}
