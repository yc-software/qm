import type { ComposerVariant } from "../composer-variant";
import type { ComposerVariantModule } from "../composer-parts";
import { chatgpt } from "./chatgpt";
import { claude } from "./claude";
import { cursor } from "./cursor";
import { perplexity } from "./perplexity";
import { t3 } from "./t3";

export const COMPOSER_VARIANT_MODULES: Partial<Record<ComposerVariant, ComposerVariantModule>> = {
  chatgpt,
  claude,
  t3,
  perplexity,
  cursor,
};
