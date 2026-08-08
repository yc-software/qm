#!/usr/bin/env python3
"""Slack draft helper: creates a draft in the user's Slack composer, as the user.

Usage (token from $VAULT_TOKEN_SLACK_COM):
  slack_drafts.py create --to '#channel-name' --text 'hello'
  slack_drafts.py create --to '@display-name' --text-file body.txt
  slack_drafts.py create --to C0123ABCDEF --thread-ts 1712345678.000100 --text 'reply'
  slack_drafts.py resolve --to '#channel-name'

Only drafts.create accepts an OAuth user token; drafts cannot be listed, edited,
or deleted through this API — the person manages the draft in their Slack client.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import uuid

API = "https://slack.com/api"


def call(method: str, body: dict | None = None, query: dict | None = None):
    tok = os.environ.get("VAULT_TOKEN_SLACK_COM", "")
    if not tok:
        sys.exit("no Slack token: ask the user to connect Slack")
    url = f"{API}/{method}" + (f"?{urllib.parse.urlencode(query, doseq=True)}" if query else "")
    cmd = ["curl", "-sS", "--fail-with-body", "--max-time", "60",
           "-H", f"Authorization: Bearer {tok}", url]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json; charset=utf-8", "--data-binary", "@-"]
    proc = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"slack api unreachable on {method}: {proc.stderr.strip()[:300]}")
    try:
        payload = json.loads(proc.stdout)
    except ValueError:
        sys.exit(f"slack api returned non-JSON on {method}: {proc.stdout[:300]}")
    if not payload.get("ok"):
        err = payload.get("error")
        hints = {
            "missing_scope": "the user connected Slack before this permission existed — ask them to reconnect Slack",
            "attached_draft_exists": "that conversation's composer already holds a draft — ask the user to send or discard it first",
        }
        detail = "; ".join(payload.get("response_metadata", {}).get("messages", []))
        parts = [p for p in (detail, hints.get(str(err))) if p]
        sys.exit(f"slack api error on {method}: {err}{' — ' + '; '.join(parts) if parts else ''}")
    return payload


def paginate(method: str, query: dict, key: str):
    cursor = None
    while True:
        q = dict(query)
        if cursor:
            q["cursor"] = cursor
        payload = call(method, query=q)
        yield from payload.get(key, [])
        cursor = payload.get("response_metadata", {}).get("next_cursor") or None
        if not cursor:
            return


URL_RE = re.compile(r"https?://[^\s<>|]+")


def text_to_blocks(text: str) -> list:
    elements = []
    last = 0
    for m in URL_RE.finditer(text):
        if m.start() > last:
            elements.append({"type": "text", "text": text[last:m.start()]})
        elements.append({"type": "link", "url": m.group(0)})
        last = m.end()
    if last < len(text):
        elements.append({"type": "text", "text": text[last:]})
    if not elements:
        sys.exit("draft text is empty")
    return [{"type": "rich_text", "elements": [{"type": "rich_text_section", "elements": elements}]}]


def find_channel(name: str) -> str:
    want = name.lstrip("#").lower()
    for ch in paginate(
        "conversations.list",
        {"types": "public_channel,private_channel,mpim", "exclude_archived": "true", "limit": 200},
        "channels",
    ):
        if str(ch.get("name", "")).lower() == want:
            return ch["id"]
    sys.exit(f"no channel named #{want} visible to this user")


def find_user(name: str) -> str:
    want = name.lstrip("@").lower()
    matches = []
    for u in paginate("users.list", {"limit": 200}, "members"):
        if u.get("deleted"):
            continue
        profile = u.get("profile", {})
        names = {
            str(u.get("name", "")).lower(),
            str(profile.get("display_name", "")).lower(),
            str(profile.get("real_name", "")).lower(),
            str(profile.get("email", "")).lower(),
        }
        if want in names:
            matches.append(u["id"])
    if len(matches) == 1:
        return matches[0]
    if not matches:
        sys.exit(f"no Slack user matching '{name}'")
    sys.exit(f"'{name}' is ambiguous ({len(matches)} users) — use a user ID")


def open_im(user_id: str) -> str:
    payload = call("conversations.open", body={"users": user_id})
    return payload["channel"]["id"]


def resolve_destination(to: str) -> str:
    if re.fullmatch(r"[CGD][A-Z0-9]{8,}", to):
        return to
    if re.fullmatch(r"[UW][A-Z0-9]{8,}", to):
        return open_im(to)
    if to.startswith("#"):
        return find_channel(to)
    if to.startswith("@") or "@" in to:
        return open_im(find_user(to))
    return find_channel(to)


def read_text(args) -> str:
    if args.text is not None:
        return args.text
    if args.text_file == "-":
        return sys.stdin.read().rstrip("\n")
    with open(args.text_file, encoding="utf-8") as f:
        return f.read().rstrip("\n")


def cmd_create(args):
    channel = resolve_destination(args.to)
    destination = {"channel_id": channel}
    if args.thread_ts:
        destination["thread_ts"] = args.thread_ts
    payload = call(
        "drafts.create",
        body={
            "blocks": text_to_blocks(read_text(args)),
            "destinations": [destination],
            "file_ids": [],
            "is_from_composer": False,
            "client_msg_id": str(uuid.uuid4()),
        },
    )
    draft = payload.get("draft", {})
    print(json.dumps({"ok": True, "draftId": draft.get("id"), "channel": channel}))


def cmd_resolve(args):
    print(json.dumps({"channel": resolve_destination(args.to)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    create = sub.add_parser("create")
    create.add_argument("--to", required=True)
    group = create.add_mutually_exclusive_group(required=True)
    group.add_argument("--text")
    group.add_argument("--text-file")
    create.add_argument("--thread-ts")
    create.set_defaults(fn=cmd_create)
    resolve = sub.add_parser("resolve")
    resolve.add_argument("--to", required=True)
    resolve.set_defaults(fn=cmd_resolve)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
