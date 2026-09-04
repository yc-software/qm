import { marked } from "marked";

const registered = new Set<string>();
const originalUse = marked.use.bind(marked);

marked.use = (...configs: Parameters<typeof marked.use>): typeof marked => {
  const fresh = configs.filter((config) => {
    const exts = (config as { extensions?: Array<{ name?: string }> }).extensions;
    if (!exts?.length) return true;
    const names = exts.map((e) => e.name).filter((n): n is string => typeof n === "string");
    const carriesOtherKeys = Object.keys(config as object).some((k) => k !== "extensions");
    if (!carriesOtherKeys && names.length === exts.length && names.every((n) => registered.has(n))) return false;
    for (const n of names) registered.add(n);
    return true;
  });
  return fresh.length ? originalUse(...fresh) : marked;
};
