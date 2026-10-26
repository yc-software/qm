import argparse
import base64
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import time
import uuid
import zlib
from pathlib import Path

PART_SIZE = 64 * 1024 * 1024


class RequestError(RuntimeError):
    def __init__(self, status, message, content=b""):
        super().__init__(message)
        self.status = status
        self.content = content


def quote(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def error_code(content):
    try:
        return json.loads(content).get("error")
    except (ValueError, AttributeError):
        return None


def request(method, url, data=None, headers=None):
    config = [f"url = {quote(url)}", f"request = {quote(method)}", "silent", "show-error", "max-time = 180", 'write-out = "\\n%{http_code}"']
    config += [f"header = {quote(f'{name}: {value}')}" for name, value in (headers or {}).items()]
    if data is not None:
        config.append('data-binary = "@-"')
    failure = ""
    for attempt in range(5):
        read_end, write_end = os.pipe()
        with os.fdopen(write_end, "w") as pipe:
            pipe.write("\n".join(config) + "\n")
        with os.fdopen(read_end) as pipe:
            try:
                result = subprocess.run(["curl", "-K", f"/dev/fd/{pipe.fileno()}"], input=data or b"", capture_output=True, pass_fds=(pipe.fileno(),))
            except FileNotFoundError:
                raise RuntimeError("curl is required; install it and rerun") from None
        content, _, status = result.stdout.rpartition(b"\n")
        if result.returncode == 0:
            status = int(status or b"0")
            if 200 <= status < 300:
                return content
            if status < 500 and (status != 429 or error_code(content) == "upload_quota"):
                raise RequestError(status, f"request failed ({status}): {content[:4096].decode(errors='replace')}", content)
            failure = f"HTTP {status}: {content[:200].decode(errors='replace')}"
        else:
            failure = result.stderr.decode(errors="replace").strip() or f"curl exited {result.returncode}"
        if attempt == 4:
            raise RuntimeError(f"transfer failed after retries ({failure}); rerun with the same state file")
        time.sleep(2 ** attempt)


def api(method, path, data=None):
    headers = {"x-agent-capability": os.environ["AGENT_API_TOKEN"], "content-type": "application/json"}
    body = None if data is None else json.dumps(data).encode()
    return json.loads(request(method, os.environ["AGENT_API_URL"].rstrip("/") + path, body, headers))


def describe(listing):
    lines = [f"{'id':32}  {'state':10}  {'size':>12}  {'started (UTC)':16}  {'last activity (UTC)':19}  name"]
    when = lambda ms: time.strftime("%Y-%m-%d %H:%M", time.gmtime(ms / 1000)) if ms else "-"
    for upload in listing["uploads"]:
        lines.append(f"{upload['id']:32}  {upload['state']:10}  {upload['sizeBytes']:>12}  {when(upload['createdAt']):16}  {when(upload.get('lastActivityAt')):19}  {upload['name']}")
    if not listing["uploads"]:
        lines.append("(no unfinished uploads in this conversation)")
    if listing["elsewhere"]:
        lines.append(f"{listing['elsewhere']} more unfinished upload(s) belong to other conversations and can only be aborted there.")
    return "\n".join(lines)


def save(path, state):
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(state, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description="Publish a file durably to Files with resumable direct uploads")
    parser.add_argument("file", type=Path, nargs="?")
    parser.add_argument("--state", type=Path)
    parser.add_argument("--scope")
    parser.add_argument("--name")
    parser.add_argument("--list", action="store_true", help="list your unfinished uploads")
    parser.add_argument("--abort", nargs="+", metavar="ID", help="abort unfinished uploads by id")
    args = parser.parse_args()
    if args.list:
        print(describe(api("GET", "/v1/files/uploads")))
        return
    if args.abort:
        for upload_id in args.abort:
            api("DELETE", f"/v1/files/uploads/{upload_id}")
            print(f"aborted {upload_id}")
        return
    if args.file is None:
        parser.error("a file path, --list or --abort is required")
    state_path = args.state or args.file.with_name(args.file.name + ".qm-upload.json")
    checksums = []
    size = 0
    with args.file.open("rb") as source:
        while chunk := source.read(PART_SIZE):
            size += len(chunk)
            checksums.append(base64.b64encode(hashlib.sha256(chunk).digest()).decode())
    if not checksums:
        checksums.append(base64.b64encode(hashlib.sha256(b"").digest()).decode())
    token_parts = os.environ["AGENT_API_TOKEN"].split(".")
    claims = json.loads(base64.urlsafe_b64decode(token_parts[1 if len(token_parts) == 3 else 0] + "==="))
    if "encoding" in claims:
        if claims["encoding"] != "deflate-raw":
            raise RuntimeError("unsupported capability encoding")
        inflater = zlib.decompressobj(-zlib.MAX_WBITS)
        decoded = inflater.decompress(base64.urlsafe_b64decode(claims["claims"] + "==="), 1024 * 1024 + 1)
        if len(decoded) > 1024 * 1024 or not inflater.eof:
            raise RuntimeError("invalid or oversized capability claims")
        claims = json.loads(decoded)
    destination = {"origin": os.environ["AGENT_API_URL"].rstrip("/"), "actor": claims["actorId"], "scope": args.scope or claims["scopeId"]}
    manifest = {"name": args.name or args.file.name, "mimetype": mimetypes.guess_type(args.file.name)[0] or "application/octet-stream", "sizeBytes": size, "checksums": checksums}
    if args.scope:
        manifest["scopeId"] = args.scope
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    if state and state.get("destination") != destination:
        raise RuntimeError("destination changed; use another --state path for a new upload")
    if state and state["manifest"] != manifest:
        if "file" not in state:
            try:
                api("DELETE", f"/v1/files/uploads/{state['id']}")
            except (RequestError, RuntimeError) as error:
                print(f"could not cancel the previous unfinished upload: {error}", file=sys.stderr)
        state = None
    status = None
    if state:
        try:
            status = api("GET", f"/v1/files/uploads/{state['id']}")["upload"]
        except RequestError as error:
            if error.status != 404:
                raise
        expired = status and status["state"] == "pending" and status["expiresAt"] <= time.time() * 1000
        if status and "file" not in state and (expired or status["state"] in ("aborted", "failed")):
            print(f"starting a new upload: saved upload {state['id']} is {'expired' if expired else status['state']}", file=sys.stderr)
            state = status = None
    if not state:
        state = {"id": uuid.uuid4().hex, "manifest": manifest, "destination": destination, "next": 1}
        save(state_path, state)
    if status is None:
        try:
            status = api("POST", "/v1/files/uploads", {**manifest, "requestId": state["id"]})["upload"]
        except RequestError as error:
            if error_code(error.content) != "upload_quota":
                raise
            me = f"python3 {sys.argv[0]}"
            raise RuntimeError(f"{json.loads(error.content)['message']}\n\n{describe(json.loads(error.content))}\n\nAbort one with: {me} --abort ID\nThen rerun this upload. List again with: {me} --list") from None
    if status["state"] == "pending":
        with args.file.open("rb") as source:
            for number in range(state["next"], len(checksums) + 1):
                source.seek((number - 1) * PART_SIZE)
                chunk = source.read(PART_SIZE)
                checksum = base64.b64encode(hashlib.sha256(chunk).digest()).decode()
                if checksum != checksums[number - 1]:
                    raise RuntimeError("file changed during upload; leave it unchanged and retry")
                for signing_attempt in range(3):
                    signed = api("POST", f"/v1/files/uploads/{state['id']}/parts/{number}", {})
                    try:
                        request("PUT", signed["url"], chunk, signed["headers"])
                        break
                    except RequestError as error:
                        if error.status != 403 or signing_attempt == 2:
                            raise
                state["next"] = number + 1
                save(state_path, state)
                print(f"Uploaded part {number}/{len(checksums)}", file=sys.stderr)
    result = api("POST", f"/v1/files/uploads/{state['id']}/complete", {})
    state["file"] = result["file"]
    save(state_path, state)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
