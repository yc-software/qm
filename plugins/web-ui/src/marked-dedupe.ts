import { marked } from "marked";

const BLOCKED = new Set(["inlineMathDollar"]);
const registered = new Set<string>();
const originalUse = marked.use.bind(marked);

marked.use = (...configs: Parameters<typeof marked.use>): typeof marked => {
  const fresh: Parameters<typeof marked.use> = [];
  for (const config of configs) {
    const exts = (config as { extensions?: Array<{ name?: string }> }).extensions;
    if (!exts?.length) {
      fresh.push(config);
      continue;
    }
    const allowed = exts.filter((e) => typeof e.name !== "string" || !BLOCKED.has(e.name));
    const names = allowed.map((e) => e.name).filter((n): n is string => typeof n === "string");
    const carriesOtherKeys = Object.keys(config as object).some((k) => k !== "extensions");
    if (
      !carriesOtherKeys &&
      (!allowed.length || (names.length === allowed.length && names.every((n) => registered.has(n))))
    )
      continue;
    for (const n of names) registered.add(n);
    if (allowed.length === exts.length) {
      fresh.push(config);
    } else {
      const next = { ...config };
      if (allowed.length) next.extensions = allowed as typeof config.extensions;
      else delete next.extensions;
      fresh.push(next);
    }
  }
  return fresh.length ? originalUse(...fresh) : marked;
};
