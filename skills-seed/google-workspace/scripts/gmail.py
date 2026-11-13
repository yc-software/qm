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
from email import message_from_string
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formataddr, getaddresses, parseaddr, parsedate_to_datetime
from html.parser import HTMLParser

API = "https://gmail.googleapis.com/gmail/v1/users/me"
BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1"
BATCH_SIZE = 20


ACCOUNT: str | None = None


def send(method: str, url: str, what: str, body: dict | str | None = None,
         content_type: str = "application/json") -> str:
    global ACCOUNT
    tok = os.environ.get("VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM", "")
    base, cap = os.environ.get("AGENT_API_URL", ""), os.environ.get("AGENT_API_TOKEN", "")
    head = None
    if tok:
        cmd = ["curl", "-sS", "--max-time", "60", "-X", method,
               "-H", f"Authorization: Bearer {tok}", "-H", f"Content-Type: {content_type}",
               "-w", "\n%{http_code}", url]
        payload = body if body is None or isinstance(body, str) else json.dumps(body)
    elif base and cap:
        head = tempfile.NamedTemporaryFile(prefix="gmail-proxy-", delete=False)
        head.close()
        cmd = ["curl", "-sS", "--max-time", "120", "-X", "POST", "-D", head.name,
               "-H", f"X-Agent-Capability: {cap}", "-H", "Content-Type: application/json",
               "-w", "\n%{http_code}", f"{base}/v1/composio/proxy"]
        payload = json.dumps({"method": method, "url": url,
                              **({"body": body} if body is not None else {}),
                              **({"headers": {"Content-Type": content_type}} if isinstance(body, str) else {}),
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
        sys.exit(f"gmail api unreachable on {what}: {res.stderr.strip()[:500]}")
    text, _, status = res.stdout.rpartition("\n")
    if not status.startswith("2"):
        sys.exit(f"gmail api {status} on {what}: {text[:500]}")
    return text


def call(method: str, path: str, body: dict | None = None, query: dict | None = None):
    url = f"{API}/{path}" + (f"?{urllib.parse.urlencode(query, doseq=True)}" if query else "")
    text = send(method, url, f"{method} {path}", body)
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        sys.exit(f"gmail api non-json response on {method} {path}: {text[:500]}")


def batch_get(paths: dict[str, str]) -> list[tuple[str, int, str]]:
    request = EmailMessage(policy=SMTP)
    request["Content-Type"] = "multipart/mixed"
    for key, path in paths.items():
        part = EmailMessage(policy=SMTP)
        part["Content-Type"] = "application/http"
        part["Content-ID"] = f"<{key}>"
        part.set_payload(f"GET {path}\r\n")
        request.attach(part)
    body = request.as_string().partition("\r\n\r\n")[2]
    text = send("POST", BATCH_URL, "POST batch", body, request["Content-Type"])
    boundary = text.lstrip().split("\n", 1)[0].strip().removeprefix("--")
    reply = message_from_string(f'Content-Type: multipart/mixed; boundary="{boundary}"\n\n{text}')
    if not reply.is_multipart():
        sys.exit(f"gmail api non-multipart response on POST batch: {text[:500]}")
    results = []
    for part in reply.get_payload():
        status_line, _, rest = part.get_payload().lstrip().partition("\n")
        key = part["Content-ID"].strip().strip("<>").removeprefix("response-")
        results.append((key, int(status_line.split()[1]), message_from_string(rest).get_payload()))
    return results


def message_metadata(ids: list[str]) -> dict[str, dict]:
    query = urllib.parse.urlencode({"format": "metadata", "metadataHeaders": ["From", "Date", "Subject"]}, doseq=True)
    found: dict[str, dict] = {}
    pending = ids
    while pending:
        limited = []
        for start in range(0, len(pending), BATCH_SIZE):
            chunk = pending[start:start + BATCH_SIZE]
            for mid, status, body in batch_get({m: f"/gmail/v1/users/me/messages/{m}?{query}" for m in chunk}):
                if status == 200:
                    found[mid] = json.loads(body)
                elif status == 429:
                    limited.append(mid)
                else:
                    sys.exit(f"gmail api {status} on GET messages/{mid}: {body[:500]}")
        if len(limited) == len(pending):
            sys.exit(f"gmail api 429 on GET messages: every message in the round was rate limited: {body[:500]}")
        pending = limited
    return found


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
QUOTE_STYLE = "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"


def esc(text: str) -> str:
    return html.escape(text).replace("&#x27;", "&#39;")


def keep_spaces(line: str) -> str:
    out: list[str] = []
    for i, ch in enumerate(line):
        after = line[i + 1:i + 2]
        hard = not out or out[-1] == " " or (after == " " and out[-1] != "\u00a0")
        out.append("\u00a0" if ch == " " and hard else ch)
    return "".join(out)


def html_line(line: str) -> str:
    if not line:
        return "<br>"
    text, out, last = keep_spaces(line), [], 0
    for m in URL_RE.finditer(text):
        url = m.group(0)
        closers = {")": "(", "]": "[", "}": "{"}
        while url:
            ch = url[-1]
            unbalanced = ch in closers and url.count(closers[ch]) < url.count(ch)
            if ch in ".,;:!?\u201c\u201d\u2018\u2019\u00ab\u00bb\u2026" or unbalanced:
                url = url[:-1]
            else:
                break
        out.append(esc(text[last:m.start()]))
        out.append(f'<a href="{esc(url)}">{esc(url)}</a>')
        last = m.start() + len(url)
    return "".join(out) + esc(text[last:])


def html_mirror(text: str) -> str:
    first, *rest = text.split("\n")
    return '<div dir="ltr">' + html_line(first) + "".join(f"<div>{html_line(ln)}</div>" for ln in rest) + "</div>"


class QuotedBody(HTMLParser):
    SKIP = {"head", "style", "script", "title"}
    DROP = {"html", "body", "meta", "link", "base"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.out: list[str] = []
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1
        elif not self.skipping and tag not in self.DROP and not (
                tag == "img" and (dict(attrs).get("src") or "").lower().startswith("cid:")):
            self.out.append(self.get_starttag_text())

    def handle_startendtag(self, tag, attrs):
        if tag not in self.SKIP:
            self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skipping = max(0, self.skipping - 1)
        elif not self.skipping and tag not in self.DROP and tag != "img":
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.skipping:
            self.out.append(data)

    def handle_entityref(self, name):
        self.handle_data(f"&{name};")

    def handle_charref(self, name):
        self.handle_data(f"&#{name};")

    def handle_comment(self, data):
        self.handle_data(f"<!--{data}-->")


def quoted_html(markup: str) -> str:
    parser = QuotedBody()
    parser.feed(markup)
    parser.close()
    return "".join(parser.out)


def part_text(payload: dict, mime: str) -> str:
    return "\n".join(b64url_decode(p["body"]["data"]) for p in walk_parts(payload)
                     if p.get("mimeType") == mime and p.get("body", {}).get("data"))


def sent_at(date: str) -> str:
    try:
        at = parsedate_to_datetime(date)
    except (TypeError, ValueError):
        print(f"note: unparseable Date {date!r}; the quote line omits the time", file=sys.stderr)
        return ""
    at = at.astimezone()
    return f"{at:%a, %b} {at.day}, {at.year} at {at.hour % 12 or 12}:{at:%M}\u202f{at:%p} "


def quote_line(line: str) -> str:
    if line.startswith(">"):
        return f">{line}"
    return f"> {line}" if line else ">"


def gmail_quote(original: dict) -> tuple[str, str]:
    h = headers_of(original["payload"])
    name, address = parseaddr(h.get("from", ""))
    attribution = sent_at(h.get("date", "")) + (f"{name} " if name else "")
    plain = part_text(original["payload"], "text/plain").replace("\r\n", "\n")
    rich = part_text(original["payload"], "text/html").replace("\r\n", "\n")
    quoted = "\n".join(quote_line(ln) for ln in plain.split("\n"))
    text = f"On {attribution}<{address}> wrote:\n\n{quoted}" if plain else ""
    markup = (f'<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">'
              f'On {esc(attribution)}&lt;<a href="mailto:{esc(address)}">'
              f'{esc(address)}</a>&gt; wrote:<br></div>'
              f'<blockquote class="gmail_quote" style="{QUOTE_STYLE}">'
              f'{quoted_html(rich) if rich else html_mirror(plain)}</blockquote></div>')
    return text, markup


def compose(body: str, original: dict | None = None) -> dict:
    text, markup = gmail_quote(original) if original else ("", "")
    return {"text": f"{body}\n\n{text}" if text else body, "html": html_mirror(body) + markup}


def build_raw(headers: dict[str, str], body: str, thread_id: str | None = None,
              original: dict | None = None) -> dict:
    msg = EmailMessage(policy=SMTP)
    for k, v in headers.items():
        if v:
            msg[k] = v
    parts = compose(body, original)
    msg.set_content(parts["text"], cte="quoted-printable")
    msg.add_alternative(parts["html"], subtype="html", cte="quoted-printable")
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return {"raw": raw, **({"threadId": thread_id} if thread_id else {})}


def replied_message(thread_id: str | None, in_reply_to: str) -> dict | None:
    if not thread_id or not in_reply_to:
        return None
    thread = call("GET", f"threads/{thread_id}", query={"format": "metadata", "metadataHeaders": ["Message-ID"]})
    for m in thread.get("messages", []):
        if headers_of(m["payload"]).get("message-id", "").strip() == in_reply_to.strip():
            return call("GET", f"messages/{m['id']}", query={"format": "full"})
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
        msgs, page = [], None
        while len(msgs) < a.limit:
            q = {"q": a.query, "maxResults": min(a.limit - len(msgs), 100),
                 **({"pageToken": page} if page else {})}
            res = call("GET", "messages", query=q)
            msgs += res.get("messages", [])
            page = res.get("nextPageToken")
            if not page:
                break
        metas = message_metadata([m["id"] for m in msgs])
        for m in msgs:
            meta = metas[m["id"]]
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
        orig = call("GET", f"messages/{(latest[-1] if latest else orig)['id']}", query={"format": "full"})
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
        message = build_raw(headers, read_body(a.body_file), orig["threadId"], orig)
        print(json.dumps(call("POST", "drafts", {"message": message})))
    elif a.cmd == "update-draft":
        d0 = call("GET", f"drafts/{a.draft_id}", query={"format": "full"})
        payload = d0["message"]["payload"]
        if any(pt.get("filename") for pt in walk_parts(payload)):
            sys.exit("draft has attachments; edit it in Gmail or create a fresh draft instead")
        h = headers_of(payload)
        headers = {k.title(): h.get(k, "") for k in
                   ("from", "to", "cc", "bcc", "subject", "in-reply-to", "references")}
        original = replied_message(d0["message"].get("threadId"), headers["In-Reply-To"])
        message = build_raw(headers, read_body(a.body_file), d0["message"].get("threadId"), original)
        print(json.dumps(call("PUT", f"drafts/{a.draft_id}", {"message": message})))
    elif a.cmd == "send-draft":
        print(json.dumps(call("POST", "drafts/send", {"id": a.draft_id})))


if __name__ == "__main__":
    main()
