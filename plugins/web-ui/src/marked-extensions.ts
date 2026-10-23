import { marked, type MarkedExtension } from "marked";
import markedKatex from "marked-katex-extension";

const SUPERSEDED_DOLLAR_MATH = ["inlineMathDollar", "blockMathDollar"];
const registered = new Set<string>(SUPERSEDED_DOLLAR_MATH);
const originalUse = marked.use.bind(marked);

marked.use = (...configs: MarkedExtension[]): typeof marked => {
  const fresh = configs.flatMap((config) => {
    if (!config.extensions) return [config];
    const extensions = config.extensions.filter((extension) => !registered.has(extension.name));
    for (const extension of extensions) registered.add(extension.name);
    const carriesOtherKeys = Object.keys(config).some((key) => key !== "extensions");
    return extensions.length || carriesOtherKeys ? [{ ...config, extensions }] : [];
  });
  return fresh.length ? originalUse(...fresh) : marked;
};

marked.use(markedKatex({ throwOnError: false, output: "html" }));
