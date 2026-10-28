import { z } from "zod";

export const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const commitShaPrefixSchema = z.string().regex(/^[0-9a-f]{7,40}$/);
export const uuidSchema = z.guid();
