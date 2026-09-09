import type { ComposerVariant } from "../composer-variant";
import type { ComposerVariantModule } from "../composer-parts";
import { scira } from "./scira";
import { openwebui } from "./openwebui";
import { librechat } from "./librechat";
import { cline } from "./cline";
import { kilo } from "./kilo";
import { assistantui } from "./assistantui";
import { vovk } from "./vovk";
import { dqnamo } from "./dqnamo";
import { beui } from "./beui";
import { headless } from "./headless";
import { modal } from "./modal";

export const COMPOSER_VARIANT_MODULES: Partial<Record<ComposerVariant, ComposerVariantModule>> = {
  scira,
  openwebui,
  librechat,
  cline,
  kilo,
  assistantui,
  vovk,
  dqnamo,
  beui,
  headless,
  modal,
};
