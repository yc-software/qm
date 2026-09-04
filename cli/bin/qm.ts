#!/usr/bin/env -S node --
import { main } from "../src/cli.ts";

await main(process.argv.slice(2));
