#!/usr/bin/env python3
"""Fetch the user's sent Gmail as a voice corpus: strip quotes/signatures, drop
automated and trivial messages, write one JSON line per email.

Usage (token from $VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM):
  fetch_sent.py [--limit 300] [--query 'newer_than:2y'] [--out voice/corpus]

Each corpus line: {"id", "date", "to", "cc", "subject", "audience", "body"} where
audience is "internal" (all recipients share the sender's work domain) or "external".
"""

import argparse
import base64
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from email.utils import getaddresses

API = "https://gmail.googleapis.com/gmail/v1/users/me"

AUTOMATED_SUBJECT = re.compile(
    r"^(accepted|declined|tentative|canceled|invitation|updated invitation|fwd?):", re.I
)
FORWARD_OR_HEADER = re.compile(
    r"^(-{2,}\s*(original|forwarded) message\s*-{2,}|from:\s.+@.+)$", re.I
)
ON_WROTE = re.compile(r"^on .+wrote:$", re.I)
ON_START = re.compile(r"^on ", re.I)


ON_WROTE_DATED = re.compile(
    r"^on\b.*\b(mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec"
    r"|may \d).*\d.*wrote:$", re.I)


CONSUMER_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
}


def call(method: str, path: str, query: dict | None = None):
    url = f"{API}/{path}" + (f"?{urllib.parse.urlencode(query, doseq=True)}" if query else "")
    tok = os.environ.get("VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", "")
    if not tok:
        sys.exit("no Gmail token: ask the user to connect Google")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"gmail api {e.code} on {method} {path}: {e.read().decode()[:500]}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"gmail api unreachable on {method} {path}: {e.reason}") from e


def headers_of(payload: dict) -> dict[str, str]:
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


def walk_parts(payload: dict):
    yield payload
    for part in payload.get("parts", []):
        yield from walk_parts(part)


def html_to_text(markup: str) -> str:
    markup = re.sub(r"(?is)<(style|script).*?</\1>", " ", markup)
    markup = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>", "\n", markup)


    out, depth = [], 0
    for token in re.split(r"(?i)(<blockquote(?![^>]*/>)[^>]*>|</blockquote\s*>)", markup):
        low = token.lower()
        if low.startswith("<blockquote"):
            depth += 1
            continue
        if low.startswith("</blockquote"):
            depth = max(0, depth - 1)
            continue
        text = html.unescape(re.sub(r"<[^>]+>", " ", token))
        for ln in text.split("\n"):
            ln = re.sub(r"[ \t]+", " ", ln).strip()
            out.append(("> " * depth) + ln if depth else ln)
    return "\n".join(out)


def extract_body(payload: dict) -> str:
    for want in ("text/plain", "text/html"):
        texts = [p["body"]["data"] for p in walk_parts(payload)
                 if p.get("mimeType") == want and p.get("body", {}).get("data")]
        if texts:
            raw = "\n".join(
                base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)).decode(errors="replace")
                for t in texts
            )
            return raw if want == "text/plain" else html_to_text(raw)
    return ""


def strip_quotes_and_signature(text: str) -> str:
    lines = text.replace("\r\n", "\n").split("\n")



    has_markers = any(ln.startswith(">") for ln in lines)
    kept: list[str] = []
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        span = 1
        if not ON_WROTE.match(s) and ON_START.match(s):

            for extra in (2, 3, 4):
                chunk = [ln.strip() for ln in lines[i:i + extra]]
                if any(ln.startswith(">") for ln in chunk[1:]):
                    break
                if ON_WROTE_DATED.match(" ".join(chunk)):
                    span = extra
                    break
        attribution = ON_WROTE.match(s) or span > 1
        if s == "--" or FORWARD_OR_HEADER.match(s) or (attribution and not has_markers):
            break
        if attribution:


            rest = next((ln for ln in lines[i + span:] if ln.strip()), "")
            if not rest.startswith(">"):
                break
            i += span
            continue
        if lines[i].startswith(">"):
            i += 1
            continue
        kept.append(lines[i])
        i += 1
    return "\n".join(kept).strip()


def audience_of(to: str, cc: str, own_domain: str) -> str:
    if own_domain in CONSUMER_DOMAINS:
        return "external"
    addrs = [a for _, a in getaddresses([to, cc]) if a]
    if addrs and all(a.lower().endswith("@" + own_domain) for a in addrs):
        return "internal"
    return "external"


def corpus_entry(mid: str, own_domain: str) -> dict | None:
    msg = call("GET", f"messages/{mid}", query={"format": "full"})
    h = headers_of(msg["payload"])
    subject = h.get("subject", "")
    body = strip_quotes_and_signature(extract_body(msg["payload"]))
    if AUTOMATED_SUBJECT.match(subject) or "unsubscribe" in body.lower() or len(body) < 80:
        return None
    return {"id": mid, "date": h.get("date"), "to": h.get("to"), "cc": h.get("cc"),
            "subject": subject, "audience": audience_of(h.get("to", ""), h.get("cc", ""), own_domain),
            "body": body}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=300)
    p.add_argument("--query", default="", help="extra Gmail query appended to in:sent")
    p.add_argument("--out", default="voice/corpus")
    a = p.parse_args()

    try:
        own = call("GET", "profile").get("emailAddress", "").lower()
        own_domain = own.split("@")[-1]

        ids: list[str] = []
        page = None
        while len(ids) < a.limit:
            query = {"q": f"in:sent {a.query}".strip(), "maxResults": min(100, a.limit - len(ids))}
            if page:
                query["pageToken"] = page
            res = call("GET", "messages", query=query)
            ids += [m["id"] for m in res.get("messages", [])]
            page = res.get("nextPageToken")
            if not page:
                break
    except RuntimeError as e:
        sys.exit(str(e))

    def fetch_one(mid: str):
        try:
            return corpus_entry(mid, own_domain)
        except RuntimeError as e:
            print(f"skipping {mid}: {e}", file=sys.stderr)
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        entries = list(pool.map(fetch_one, ids))

    os.makedirs(a.out, exist_ok=True)
    out_path = os.path.join(a.out, "corpus.jsonl")
    counts = {"internal": 0, "external": 0}
    with open(out_path, "w", encoding="utf-8") as out:
        for entry in entries:
            if entry:
                counts[entry["audience"]] += 1
                out.write(json.dumps(entry) + "\n")
    kept = counts["internal"] + counts["external"]
    print(json.dumps({"fetched": len(ids), "kept": kept, "skipped": len(ids) - kept,
                      "internal": counts["internal"], "external": counts["external"],
                      "corpus": out_path}))


if __name__ == "__main__":
    main()
