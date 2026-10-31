import { SNOWFLAKE } from "../util/snowflake.ts";

export const MESSAGE_ID_TOKEN = /^~([0-9a-z]+)$/;
const RADIX = 36;
export const SLACK_CONTAINER = /^[CDG][A-Z0-9]+$/;
const SLACK_TS = /^(\d{6,})\.(\d{1,6})$/;
const MICROS_PER_SECOND = 1_000_000;

export interface MessageIdCodec {
  encode(id: string): string;
  decode(token: string): string | null;
  isRaw(id: string): boolean;
  compare(a: string, b: string): number;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareTs(a: string, b: string): number {
  const x = SLACK_TS.exec(a);
  const y = SLACK_TS.exec(b);
  if (!x || !y) return compareText(a, b);
  return Number(x[1]) - Number(y[1]) || compareText(x[2]!.padEnd(6, "0"), y[2]!.padEnd(6, "0"));
}

function compareSnowflakes(a: string, b: string): number {
  return a.length - b.length || compareText(a, b);
}

export function encodeTs(ts: string): string {
  const m = SLACK_TS.exec(String(ts).trim());
  if (!m) return "";
  const seconds = Number(m[1]);
  const micros = Number(m[2]!.padEnd(6, "0"));
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(micros)) return "";
  const packed = seconds * MICROS_PER_SECOND + micros;
  if (!Number.isSafeInteger(packed)) return "";
  return `~${packed.toString(RADIX)}`;
}

export function decodeTs(id: string): string | null {
  const m = MESSAGE_ID_TOKEN.exec(String(id).trim());
  if (!m) return null;
  const packed = parseInt(m[1]!, RADIX);
  if (!Number.isSafeInteger(packed) || packed <= 0) return null;
  const seconds = Math.floor(packed / MICROS_PER_SECOND);
  const micros = packed % MICROS_PER_SECOND;
  return `${seconds}.${String(micros).padStart(6, "0")}`;
}

function encodeSnowflake(id: string): string {
  const trimmed = String(id).trim();
  return SNOWFLAKE.test(trimmed) ? `~${BigInt(trimmed).toString(RADIX)}` : "";
}

function decodeSnowflake(token: string): string | null {
  const m = MESSAGE_ID_TOKEN.exec(String(token).trim());
  if (!m) return null;
  let packed = 0n;
  for (const digit of m[1]!) packed = packed * BigInt(RADIX) + BigInt(parseInt(digit, RADIX));
  const id = packed.toString();
  return SNOWFLAKE.test(id) ? id : null;
}

export const SLACK_MESSAGE_IDS: MessageIdCodec = {
  encode: encodeTs,
  decode: decodeTs,
  isRaw: (id) => SLACK_TS.test(id),
  compare: compareTs,
};
export const DISCORD_MESSAGE_IDS: MessageIdCodec = {
  encode: encodeSnowflake,
  decode: decodeSnowflake,
  isRaw: (id) => SNOWFLAKE.test(id),
  compare: compareSnowflakes,
};
