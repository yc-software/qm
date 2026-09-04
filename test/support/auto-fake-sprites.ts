import { beforeEach } from "node:test";
import { installGlobalFakeSprites } from "./fake-sprites.ts";

export const fakeSprites = installGlobalFakeSprites();
beforeEach(() => fakeSprites.reset());
