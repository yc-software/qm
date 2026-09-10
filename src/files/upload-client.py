import argparse
import base64
import hashlib
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

PART_SIZE = 64 * 1024 * 1024


class RequestError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def request(method, url, data=None, headers=None):
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
            with urllib.request.urlopen(req, timeout=180) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code < 500 and error.code != 429:
                raise RequestError(error.code, f"request failed ({error.code}): {error.read(4096).decode(errors='replace')}") from None
        except (urllib.error.URLError, TimeoutError):
            pass
        if attempt == 4:
            raise RuntimeError("transfer failed after retries; rerun with the same state file")
        time.sleep(2 ** attempt)


def api(method, path, data=None):
    headers = {"x-agent-capability": os.environ["AGENT_API_TOKEN"], "content-type": "application/json"}
    body = None if data is None else json.dumps(data).encode()
    return json.loads(request(method, os.environ["AGENT_API_URL"].rstrip("/") + path, body, headers))


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
    parser.add_argument("file", type=Path)
    parser.add_argument("--state", type=Path)
    parser.add_argument("--scope")
    parser.add_argument("--name")
    args = parser.parse_args()
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
    destination = {"origin": os.environ["AGENT_API_URL"].rstrip("/"), "actor": claims["actorId"], "scope": args.scope or claims["scopeId"]}
    manifest = {"name": args.name or args.file.name, "mimetype": mimetypes.guess_type(args.file.name)[0] or "application/octet-stream", "sizeBytes": size, "checksums": checksums}
    if args.scope:
        manifest["scopeId"] = args.scope
    if state_path.exists():
        state = json.loads(state_path.read_text())
        if state["manifest"] != manifest or state.get("destination") != destination:
            raise RuntimeError("file or destination changed; use another --state path for a new upload")
    else:
        state = {"id": uuid.uuid4().hex, "manifest": manifest, "destination": destination, "next": 1}
        save(state_path, state)
    try:
        status = api("GET", f"/v1/files/uploads/{state['id']}")["upload"]
    except RequestError as error:
        if error.status != 404:
            raise
        status = api("POST", "/v1/files/uploads", {**manifest, "requestId": state["id"]})["upload"]
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
