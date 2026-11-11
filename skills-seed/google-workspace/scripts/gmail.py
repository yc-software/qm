#!/usr/bin/env python3
"""Gmail helper: owns MIME, encoding, and threading so callers only pass plain text.

Drafts and replies go out as multipart/alternative (the plain-text body plus a
generated HTML mirror): Gmail shows text/plain-only mail to recipients at an
altered, narrower width even though the sender's own view looks normal.

Uses $VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM when present; otherwise sends the same
requests through the user's app connection via QM's /v1/composio/proxy. Pass
--account ca_... before the command when several Gmail connections match.

Usage:
  gmail.py search 'newer_than:7d is:unread' [--limit 10]
  gmail.py read MESSAGE_ID [--full]
  gmail.py thread THREAD_ID [--full]    # all messages oldest-first + lastFromMe
  gmail.py draft --to EMAIL --subject TEXT --body-file FILE
  gmail.py reply MESSAGE_ID --body-file FILE [--all]   # reply-draft anchored to the
                                                       # thread's latest sent message,
                                                       # quoting it like Gmail does
  gmail.py update-draft DRAFT_ID --body-file FILE      # keeps recipients/threading/quote
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
import tempfile
import sys
import urllib.parse
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formataddr, getaddresses, parseaddr, parsedate_to_datetime
from html.parser import HTMLParser

API = "https://gmail.googleapis.com/gmail/v1/users/me"


ACCOUNT: str | None = None


def call(method: str, path: str, body: dict | None = None, query: dict | None = None):
    global ACCOUNT
    url = f"{API}/{path}" + (f"?{urllib.parse.urlencode(query, doseq=True)}" if query else "")
    tok = os.environ.get("VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", "")
    base, cap = os.environ.get("AGENT_API_URL", ""), os.environ.get("AGENT_API_TOKEN", "")
    head = None
    if tok:
        cmd = ["curl", "-sS", "--max-time", "60", "-X", method,
               "-H", f"Authorization: Bearer {tok}", "-H", "Content-Type: application/json",
               "-w", "\n%{http_code}", url]
        payload = json.dumps(body) if body is not None else None
    elif base and cap:
        head = tempfile.NamedTemporaryFile(prefix="gmail-proxy-", delete=False)
        head.close()
        cmd = ["curl", "-sS", "--max-time", "120", "-X", "POST", "-D", head.name,
               "-H", f"X-Agent-Capability: {cap}", "-H", "Content-Type: application/json",
               "-w", "\n%{http_code}", f"{base}/v1/composio/proxy"]
        payload = json.dumps({"method": method, "url": url,
                              **({"body": body} if body is not None else {}),
                              **({"accountId": ACCOUNT} if ACCOUNT else {})})
    else:
        sys.exit("no Gmail connection: ask the user to connect Gmail")
    if payload is not None:
        cmd[1:1] = ["--data-binary", "@-"]
    res = subprocess.run(cmd, input=payload, capture_output=True, text=True)
    if head:
        with open(head.name) as f:
            seen = [l.split(":", 1)[1].strip() for l in f if l.lower().startswith("x-composio-account:")]
        os.unlink(head.name)
        ACCOUNT = ACCOUNT or (seen[-1] if seen else None)
    if res.returncode != 0:
        sys.exit(f"gmail api unreachable on {method} {path}: {res.stderr.strip()[:500]}")
    text, _, status = res.stdout.rpartition("\n")
    if not status.startswith("2"):
        sys.exit(f"gmail api {status} on {method} {path}: {text[:500]}")
    if not text:
        return {}
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


def build_raw(headers: dict[str, str], body: str, thread_id: str | None = None,
              quote: tuple[str, str] | None = None) -> dict:
    msg = EmailMessage(policy=SMTP)
    for k, v in headers.items():
        if v:
            msg[k] = v
    plain, rich = body, html_alternative(body)
    if quote:
        plain, rich = plain + "\n\n" + quote[0], rich + quote[1]
    msg.set_content(plain, cte="quoted-printable")
    msg.add_alternative(rich, subtype="html", cte="quoted-printable")
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return {"raw": raw, **({"threadId": thread_id} if thread_id else {})}


def attribution(h: dict[str, str]) -> tuple[str, str]:
    try:
        dt = parsedate_to_datetime(h.get("date", ""))
        when = f"{dt:%a, %b} {dt.day}, {dt.year} at {dt.hour % 12 or 12}:{dt:%M %p} "
    except (TypeError, ValueError):
        when = ""
    name, addr = parseaddr(h.get("from", ""))
    link = f'<a href="mailto:{html.escape(addr)}">{html.escape(addr)}</a>'
    who_html = f"{html.escape(name)} &lt;{link}&gt;" if name else link
    who = f"{name} <{addr}>" if name else addr
    return f"On {when}{who} wrote:", f"On {html.escape(when)}{who_html} wrote:"


class HtmlQuote(HTMLParser):
    HIDDEN = {"head", "style", "script", "title"}

    def __init__(self, source: str):
        super().__init__(convert_charrefs=True)
        self.markup: list[str] = []
        self.text: list[str] = []
        self.hidden = 0
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag in self.HIDDEN:
            self.hidden += 1
        elif not self.hidden and tag not in ("html", "body"):
            self.markup.append(self.get_starttag_text() or "")
            if tag == "br":
                self.text.append("\n")

    def handle_endtag(self, tag):
        if tag in self.HIDDEN:
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden and tag not in ("html", "body", "br"):
            self.markup.append(f"</{tag}>")
            if tag in ("div", "p"):
                self.text.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.markup.append(html.escape(data, quote=False))
            self.text.append(data)


def quote_of(msg: dict) -> tuple[str, str] | None:
    payload = msg["payload"]
    h = headers_of(payload)
    plain = part_text(payload, "text/plain")
    rich = part_text(payload, "text/html")
    if rich:
        parsed = HtmlQuote(rich)
        rich = "".join(parsed.markup)
        plain = plain or "".join(parsed.text)
    plain = plain.replace("\r\n", "\n").strip("\n")
    if not plain:
        print(f"note: {h.get('message-id', 'the original')} has no text to quote; reply saved without a quote",
              file=sys.stderr)
        return None
    attr_plain, attr_html = attribution(h)
    quoted_plain = attr_plain + "\n\n" + "\n".join(">" + (" " + ln if ln and not ln.startswith(">") else ln)
                                                    for ln in plain.split("\n"))
    quoted_html = (
        '<br><div class="gmail_quote gmail_quote_container">'
        f'<div dir="ltr" class="gmail_attr">{attr_html}<br></div>'
        '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;'
        f'border-left:1px solid rgb(204,204,204);padding-left:1ex">{rich or html_alternative(plain)}</blockquote></div>'
    )
    return quoted_plain, quoted_html


def quote_for(thread_id: str | None, in_reply_to: str) -> tuple[str, str] | None:
    if not thread_id or not in_reply_to:
        return None
    thread = call("GET", f"threads/{thread_id}", query={"format": "metadata", "metadataHeaders": ["Message-ID"]})
    for m in thread.get("messages", []):
        if headers_of(m["payload"]).get("message-id", "").strip() == in_reply_to.strip():
            return quote_of(call("GET", f"messages/{m['id']}", query={"format": "full"}))
    print(f"note: {in_reply_to} is not in thread {thread_id}; draft saved without a quote",
          file=sys.stderr)
    return None


def headers_of(payload: dict) -> dict[str, str]:
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


def b64url_decode(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode(errors="replace")


def walk_parts(payload: dict):
    yield payload
    for part in payload.get("parts", []):
        yield from walk_parts(part)


def part_text(payload: dict, want: str) -> str:
    texts = [p["body"]["data"] for p in walk_parts(payload)
             if p.get("mimeType") == want and p.get("body", {}).get("data")
             and not p.get("filename")]
    return "\n".join(b64url_decode(t) for t in texts)


def extract_body(payload: dict) -> str:
    return part_text(payload, "text/plain") or part_text(payload, "text/html")


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
    global ACCOUNT
    p = argparse.ArgumentParser()
    p.add_argument("--account", help="app connection id (ca_...) when several Gmail connections match")
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
    ACCOUNT = a.account

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
        orig = call("GET", f"messages/{latest[-1]['id'] if latest else a.id}", query={"format": "full"})
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
        message = build_raw(headers, read_body(a.body_file), orig["threadId"], quote_of(orig))
        print(json.dumps(call("POST", "drafts", {"message": message})))
    elif a.cmd == "update-draft":
        d0 = call("GET", f"drafts/{a.draft_id}", query={"format": "full"})
        payload = d0["message"]["payload"]
        if any(pt.get("filename") for pt in walk_parts(payload)):
            sys.exit("draft has attachments; edit it in Gmail or create a fresh draft instead")
        h = headers_of(payload)
        headers = {k.title(): h.get(k, "") for k in
                   ("from", "to", "cc", "bcc", "subject", "in-reply-to", "references")}
        quote = quote_for(d0["message"].get("threadId"), headers["In-Reply-To"])
        message = build_raw(headers, read_body(a.body_file), d0["message"].get("threadId"), quote)
        print(json.dumps(call("PUT", f"drafts/{a.draft_id}", {"message": message})))
    elif a.cmd == "send-draft":
        print(json.dumps(call("POST", "drafts/send", {"id": a.draft_id})))


if __name__ == "__main__":
    main()
