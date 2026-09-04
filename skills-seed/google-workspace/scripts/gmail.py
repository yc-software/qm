#!/usr/bin/env python3
"""Gmail helper: owns MIME, encoding, and threading so callers only pass plain text.

Drafts and replies go out as multipart/alternative (the plain-text body plus a
generated HTML mirror): Gmail shows text/plain-only mail to recipients at an
altered, narrower width even though the sender's own view looks normal.

Usage (token from $VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM):
  gmail.py search 'newer_than:7d is:unread' [--limit 10]
  gmail.py read MESSAGE_ID [--full]
  gmail.py thread THREAD_ID [--full]    # all messages oldest-first + lastFromMe
  gmail.py draft --to EMAIL --subject TEXT --body-file FILE
  gmail.py reply MESSAGE_ID --body-file FILE [--all]   # reply-draft anchored to the
                                                       # thread's latest sent message
  gmail.py update-draft DRAFT_ID --body-file FILE      # keeps recipients/threading
  gmail.py send-draft DRAFT_ID

Body files are plain text. Lines that look hard-wrapped (long lines inside a
paragraph) are rejoined into flowing prose; short lines (sign-offs, lists) keep
their breaks. Blank lines separate paragraphs.
"""

import argparse
import base64
import html
import json
import os
import re
import subprocess
import sys
import urllib.parse
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formataddr, getaddresses

API = "https://gmail.googleapis.com/gmail/v1/users/me"


def call(method: str, path: str, body: dict | None = None, query: dict | None = None):
    url = f"{API}/{path}" + (f"?{urllib.parse.urlencode(query, doseq=True)}" if query else "")
    tok = os.environ.get("VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", "")
    if not tok:
        sys.exit("no Gmail token: ask the user to connect Google")
    # curl, not urllib: the sandbox egress proxy is an https:// CONNECT proxy,
    # which python's urllib cannot tunnel through.
    cmd = ["curl", "-sS", "--max-time", "60", "-X", method,
           "-H", f"Authorization: Bearer {tok}", "-H", "Content-Type: application/json",
           "-w", "\n%{http_code}", url]
    if body is not None:
        cmd[1:1] = ["--data-binary", "@-"]
    res = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                         capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"gmail api unreachable on {method} {path}: {res.stderr.strip()[:500]}")
    text, _, status = res.stdout.rpartition("\n")
    if not status.startswith("2"):
        sys.exit(f"gmail api {status} on {method} {path}: {text[:500]}")
    try:
        return json.loads(text)
    except ValueError:
        sys.exit(f"gmail api {status} on {method} {path}: non-json response: {text[:500]}")


def read_body(path: str) -> str:
    if path == "-":
        text = sys.stdin.read()
    else:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    out: list[str] = []
    for paragraph in text.replace("\r\n", "\n").split("\n\n"):
        lines = [ln.rstrip() for ln in paragraph.split("\n") if ln.strip()]
        joined = ""
        for ln in lines:


            joined += ln + (" " if len(ln) > 60 else "\n")
        if joined:
            out.append(joined.strip())
    return "\n\n".join(out)


URL_RE = re.compile(r"https?://[^\s<>\"']+")


def linkify_escaped(text: str) -> str:
    out, last = [], 0
    for m in URL_RE.finditer(text):
        url = m.group(0)
        # Trailing punctuation belongs to the sentence, not the URL; a closing
        # bracket stays only when the URL itself opened it (wikipedia-style
        # paths, IPv6 hosts).
        closers = {")": "(", "]": "[", "}": "{"}
        while url:
            ch = url[-1]
            unbalanced = ch in closers and url.count(closers[ch]) < url.count(ch)
            if ch in ".,;:!?\u201c\u201d\u2018\u2019\u00ab\u00bb\u2026" or unbalanced:
                url = url[:-1]
            else:
                break
        out.append(html.escape(text[last:m.start()]))
        out.append(f'<a href="{html.escape(url, quote=True)}">{html.escape(url)}</a>')
        last = m.start() + len(url)
    out.append(html.escape(text[last:]))
    return "".join(out)


def html_alternative(body: str) -> str:
    # Gmail renders text/plain-only mail at a narrower measure for recipients
    # (the sender's composer view looks normal), so every message carries a
    # text/html mirror of the same body, shaped like Gmail's own composer output.
    paragraphs = ["<br>".join(linkify_escaped(ln) for ln in p.split("\n")) for p in body.split("\n\n")]
    return '<div dir="ltr">' + "<br><br>".join(paragraphs) + "</div>"


def build_raw(headers: dict[str, str], body: str, thread_id: str | None = None) -> dict:
    msg = EmailMessage(policy=SMTP)
    for k, v in headers.items():
        if v:
            msg[k] = v
    msg.set_content(body, cte="quoted-printable")
    msg.add_alternative(html_alternative(body), subtype="html", cte="quoted-printable")
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return {"raw": raw, **({"threadId": thread_id} if thread_id else {})}


def headers_of(payload: dict) -> dict[str, str]:
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


def b64url_decode(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode(errors="replace")


def walk_parts(payload: dict):
    yield payload
    for part in payload.get("parts", []):
        yield from walk_parts(part)


def extract_body(payload: dict) -> str:
    for want in ("text/plain", "text/html"):
        texts = [p["body"]["data"] for p in walk_parts(payload)
                 if p.get("mimeType") == want and p.get("body", {}).get("data")]
        if texts:
            return "\n".join(b64url_decode(t) for t in texts)
    return ""


def own_address() -> str:
    return call("GET", "profile").get("emailAddress", "").lower()


def canon(addr: str) -> str:
    local, _, domain = addr.lower().partition("@")
    return f"{local.split('+')[0]}@{domain}"


def is_from(me: str, from_header: str) -> bool:
    addrs = {canon(addr) for _, addr in getaddresses([from_header]) if addr}
    return bool(me) and canon(me) in addrs


def sent_messages(thread: dict) -> list[dict]:


    skip = {"DRAFT", "TRASH", "SPAM"}
    return [m for m in thread.get("messages", []) if not skip & set(m.get("labelIds", []))]


def strip_addrs(addrs: str, exclude: str) -> str:
    drop = {a.lower() for _, a in getaddresses([exclude]) if a}
    kept = [formataddr((name, addr)) for name, addr in getaddresses([addrs])
            if addr and addr.lower() not in drop]
    return ", ".join(kept)


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--limit", type=lambda v: max(1, int(v)), default=10)
    r = sub.add_parser("read")
    r.add_argument("id")
    r.add_argument("--full", action="store_true")
    t = sub.add_parser("thread")
    t.add_argument("id")
    t.add_argument("--full", action="store_true")
    d = sub.add_parser("draft")
    d.add_argument("--to", required=True)
    d.add_argument("--subject", required=True)
    d.add_argument("--body-file", required=True)
    rp = sub.add_parser("reply")
    rp.add_argument("id")
    rp.add_argument("--body-file", required=True)
    rp.add_argument("--all", action="store_true", help="reply-all (keep every recipient)")
    u = sub.add_parser("update-draft")
    u.add_argument("draft_id")
    u.add_argument("--body-file", required=True)
    sd = sub.add_parser("send-draft")
    sd.add_argument("draft_id")
    a = p.parse_args()

    if a.cmd == "search":
        meta_q = {"format": "metadata", "metadataHeaders": ["From", "Date", "Subject"]}
        msgs, page = [], None
        while len(msgs) < a.limit:
            q = {"q": a.query, "maxResults": min(a.limit - len(msgs), 100),
                 **({"pageToken": page} if page else {})}
            res = call("GET", "messages", query=q)
            msgs += res.get("messages", [])
            page = res.get("nextPageToken")
            if not page:
                break
        for m in msgs:
            meta = call("GET", f"messages/{m['id']}", query=meta_q)
            h = headers_of(meta["payload"])
            print(json.dumps({"id": m["id"], "threadId": meta.get("threadId"),
                              "from": h.get("from"), "date": h.get("date"),
                              "subject": h.get("subject"), "snippet": meta.get("snippet")}))
        if page:
            print(f"[more results exist beyond --limit {a.limit}]", file=sys.stderr)
    elif a.cmd == "read":
        msg = call("GET", f"messages/{a.id}", query={"format": "full" if a.full else "metadata"})
        h = headers_of(msg["payload"])
        out = {"id": a.id, "threadId": msg["threadId"], "from": h.get("from"), "to": h.get("to"),
               "cc": h.get("cc"), "subject": h.get("subject"), "snippet": msg.get("snippet")}
        if a.full:
            out["body"] = extract_body(msg["payload"])
        print(json.dumps(out))
    elif a.cmd == "thread":
        thread = call("GET", f"threads/{a.id}",
                      query={"format": "full" if a.full else "metadata"})
        me = own_address()
        msgs = []
        for m in sent_messages(thread):
            h = headers_of(m["payload"])
            entry = {"id": m["id"], "from": h.get("from"), "to": h.get("to"),
                     "date": h.get("date"), "subject": h.get("subject"),
                     "fromMe": is_from(me, h.get("from", "")),
                     "snippet": m.get("snippet")}
            if a.full:
                entry["body"] = extract_body(m["payload"])
            msgs.append(entry)
        print(json.dumps({"threadId": a.id, "lastFromMe": bool(msgs) and msgs[-1]["fromMe"],
                          "messages": msgs}))
    elif a.cmd == "draft":
        message = build_raw({"To": a.to, "Subject": a.subject}, read_body(a.body_file))
        print(json.dumps(call("POST", "drafts", {"message": message})))
    elif a.cmd == "reply":
        orig = call("GET", f"messages/{a.id}", query={"format": "metadata"})


        latest = sent_messages(call("GET", f"threads/{orig['threadId']}",
                                    query={"format": "metadata"}))
        orig = latest[-1] if latest else orig
        h = headers_of(orig["payload"])
        subject = h.get("subject", "")
        me = own_address()

        sender = h.get("reply-to") or h.get("from", "")
        if strip_addrs(sender, me) == "":
            sender = h.get("to", "")
        headers = {
            "To": sender,
            "Subject": subject if subject.lower().startswith("re:") else f"Re: {subject}",
            "In-Reply-To": h.get("message-id", ""),
            "References": f"{h.get('references', '')} {h.get('message-id', '')}".strip(),
        }
        if a.all:
            headers["Cc"] = strip_addrs(f"{h.get('to', '')}, {h.get('cc', '')}", f"{me}, {headers['To']}")
        message = build_raw(headers, read_body(a.body_file), orig["threadId"])
        print(json.dumps(call("POST", "drafts", {"message": message})))
    elif a.cmd == "update-draft":
        d0 = call("GET", f"drafts/{a.draft_id}", query={"format": "full"})
        payload = d0["message"]["payload"]
        if any(pt.get("filename") for pt in walk_parts(payload)):
            sys.exit("draft has attachments; edit it in Gmail or create a fresh draft instead")
        h = headers_of(payload)
        headers = {k.title(): h.get(k, "") for k in
                   ("from", "to", "cc", "bcc", "subject", "in-reply-to", "references")}
        message = build_raw(headers, read_body(a.body_file), d0["message"].get("threadId"))
        print(json.dumps(call("PUT", f"drafts/{a.draft_id}", {"message": message})))
    elif a.cmd == "send-draft":
        print(json.dumps(call("POST", "drafts/send", {"id": a.draft_id})))


if __name__ == "__main__":
    main()
