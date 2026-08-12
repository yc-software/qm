#!/usr/bin/env node
import {
  derivePairingKey,
  generateEncodedKeyPair,
  pairingVerificationCode,
} from "../common/crypto.js";
import { fetchJson, joinUrl } from "../common/http.js";
import type { PairingFile } from "../common/protocol.js";
import { callInwise, refreshPairing } from "./commands.js";
import { loadCliConfig, saveCliConfig } from "./config.js";

interface CreatedPairing {
  pairingId: string;
  code: string;
  cliToken: string;
  expiresAt: string;
  pairCommand?: string;
}

function option(
  args: string[],
  name: string,
  fallback?: string,
): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((value, index) =>
    value === name && args[index + 1] ? [args[index + 1]!] : [],
  );
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]!.startsWith("--")) index += 1;
    else values.push(args[index]!);
  }
  return values;
}

function numberOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function usage(): never {
  console.error(`Usage:
  inwise auth login [--relay URL]
  inwise auth confirm VERIFICATION_CODE
  inwise auth status [--quiet]
  inwise status
  inwise meetings search QUERY [--limit N]
  inwise meetings get MEETING_ID
  inwise transcript MEETING_ID [--offset N]
  inwise actions list [--status STATUS] [--meeting ID] [--limit N]
  inwise actions get ACTION_ID
  inwise people list [--search QUERY] [--limit N]
  inwise people get PERSON_ID
  inwise upcoming [--hours N] [--limit N]
  inwise prepare [--person ID] [--event ID] [--title TEXT] [--attendee EMAIL]
  inwise call READ_ONLY_TOOL [--json JSON]`);
  process.exit(2);
}

async function auth(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "login") {
    const relayUrl = (
      option(rest, "--relay") ?? process.env.INWISE_QM_RELAY_URL
    )?.replace(/\/$/, "");
    if (!relayUrl)
      throw new Error("Pass --relay URL or set INWISE_QM_RELAY_URL");
    const keys = generateEncodedKeyPair();
    const created = await fetchJson<CreatedPairing>(
      joinUrl(relayUrl, "/v1/pairings"),
      {
        method: "POST",
        body: JSON.stringify({ cliPublicKey: keys.publicKey }),
      },
    );
    saveCliConfig({
      pairingId: created.pairingId,
      relayUrl,
      cliToken: created.cliToken,
      cliPublicKey: keys.publicKey,
      cliPrivateKey: keys.privateKey,
    });
    console.log(`Pairing code: ${created.code}`);
    console.log(`Expires: ${created.expiresAt}`);
    console.log(
      created.pairCommand ??
        `On the Inwise laptop, run: inwise-qm-edge pair --relay ${relayUrl} --code ${created.code}`,
    );
    return;
  }
  if (subcommand === "status") {
    const quiet = rest.includes("--quiet");
    const config = await refreshPairing(loadCliConfig());
    saveCliConfig(config);
    if (!quiet)
      console.log(
        JSON.stringify(
          {
            paired: Boolean(config.edgePublicKey),
            confirmed: Boolean(config.confirmedAt),
            deviceName: config.deviceName,
            verificationCode: config.edgePublicKey
              ? pairingVerificationCode(
                  derivePairingKey(
                    config.cliPrivateKey,
                    config.edgePublicKey,
                    config.pairingId,
                  ),
                  config.pairingId,
                )
              : undefined,
          },
          null,
          2,
        ),
      );
    if (!config.edgePublicKey || !config.confirmedAt) process.exitCode = 1;
    return;
  }
  if (subcommand === "confirm") {
    const [rawCode] = positional(rest);
    if (!rawCode) throw new Error("Pass the verification code shown by the Inwise laptop");
    const supplied = rawCode.trim().toUpperCase();
    const config = await refreshPairing(loadCliConfig());
    if (!config.edgePublicKey)
      throw new Error("Pairing is waiting for approval on the Inwise laptop");
    const expected = pairingVerificationCode(
      derivePairingKey(
        config.cliPrivateKey,
        config.edgePublicKey,
        config.pairingId,
      ),
      config.pairingId,
    );
    if (supplied !== expected)
      throw new Error(
        "Verification codes do not match. Stop and restart pairing; the relay may not be trustworthy.",
      );
    saveCliConfig({
      ...config,
      confirmedAt: new Date().toISOString(),
    });
    console.log("Inwise pairing keys verified.");
    return;
  }
  usage();
}

async function call(
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  let config = loadCliConfig();
  if (!config.edgePublicKey) {
    config = await refreshPairing(config);
    saveCliConfig(config);
  }
  const result = await callInwise(config, tool, args);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "auth") return auth(args);
  if (command === "status") return call("get_connection_status", {});
  if (command === "transcript") {
    const [meetingId] = positional(args);
    if (!meetingId) usage();
    return call(
      "get_transcript",
      compact({ meetingId, offset: numberOption(args, "--offset") }),
    );
  }
  if (command === "upcoming") {
    return call(
      "list_upcoming_meetings",
      compact({
        withinHours: numberOption(args, "--hours"),
        limit: numberOption(args, "--limit"),
      }),
    );
  }
  if (command === "meetings") {
    const [subcommand, value] = positional(args);
    if (subcommand === "search" && value)
      return call(
        "search_meetings",
        compact({ query: value, limit: numberOption(args, "--limit") }),
      );
    if (subcommand === "get" && value)
      return call("get_meeting", { meetingId: value });
    usage();
  }
  if (command === "actions") {
    const [subcommand, value] = positional(args);
    if (subcommand === "get" && value)
      return call("get_action_item", { actionItemId: value });
    if (subcommand === "list")
      return call(
        "list_action_items",
        compact({
          status: option(args, "--status"),
          meetingId: option(args, "--meeting"),
          limit: numberOption(args, "--limit"),
        }),
      );
    usage();
  }
  if (command === "people") {
    const [subcommand, value] = positional(args);
    if (subcommand === "get" && value)
      return call("get_person", { personId: value });
    if (subcommand === "list")
      return call(
        "list_people",
        compact({
          search: option(args, "--search"),
          limit: numberOption(args, "--limit"),
        }),
      );
    usage();
  }
  if (command === "prepare") {
    return call(
      "prepare_meeting",
      compact({
        personId: option(args, "--person"),
        eventId: option(args, "--event"),
        title: option(args, "--title"),
        attendees: options(args, "--attendee"),
      }),
    );
  }
  if (command === "call") {
    const [tool] = positional(args);
    if (!tool) usage();
    const raw = option(args, "--json", "{}")!;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("--json must be a JSON object");
    return call(tool, parsed as Record<string, unknown>);
  }
  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
