#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import uuid


def receive(process, timeout=15):
    readable, _, _ = select.select([process.stdout], [], [], timeout)
    if not readable:
        raise RuntimeError("desk response timed out")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError("desk exited before replying")
    response = json.loads(line)["reply"]
    if response["type"] == "error":
        raise RuntimeError(response.get("message", "desk error"))
    return response


def request(process, command, sequence):
    process.stdin.write(json.dumps({"id": sequence, "cmd": command}) + "\n")
    process.stdin.flush()
    return receive(process)


def main():
    parser = argparse.ArgumentParser(description="Manual no-focus-steal acceptance test; writes only a random marker to a disposable field.")
    parser.add_argument("--desk", required=True, type=Path)
    parser.add_argument("--app", required=True)
    parser.add_argument("--x", required=True, type=float, help="Editable field x in window-relative points, not Retina pixels")
    parser.add_argument("--y", required=True, type=float, help="Editable field y in window-relative points, not Retina pixels")
    parser.add_argument("--witness", type=Path, help="Precompiled focus-witness executable")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This test must run on a Mac with Accessibility permission for its launcher.")
    marker = "desk-background-" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="desk-focus-") as directory:
        directory = Path(directory)
        witness_path = args.witness or directory / "witness"
        if not args.witness:
            subprocess.run(["swiftc", str(Path(__file__).with_name("focus-witness.swift")), "-o", str(witness_path)], check=True)
        desk = subprocess.Popen([str(args.desk.resolve()), "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        witness = None
        stop = directory / "stop"
        try:
            observed = request(desk, {"type": "observe", "app": args.app, "screenshot": False, "diff": False}, 1)
            target_pid = observed["pid"]
            print("Use an empty disposable target field. Switch to another app now and type a harmless test sentence there; do not move the mouse during the test.", flush=True)
            time.sleep(7)
            ready = directory / "ready"
            witness = subprocess.Popen([str(witness_path.resolve()), str(target_pid), str(ready), str(stop)], stdout=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 5
            while not ready.exists():
                if witness.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Witness could not start; target must not be frontmost.")
                time.sleep(0.02)
            result = request(desk, {"type": "act", "app": args.app, "actions": [
                {"type": "click", "target": {"point": {"x": args.x, "y": args.y}}},
                {"type": "type_text", "text": marker},
                {"type": "paste", "text": "-pasted"}
            ], "pace": False, "observe": True, "screenshot": False, "diff": False}, 2)
            desk.stdin.close()
            desk.wait(timeout=2)
            time.sleep(0.5)
            stop.touch()
            witness_result = json.loads(witness.communicate(timeout=5)[0])
            failure = result.get("failure") or result.get("observation_failure")
            accepted = marker + "-pasted" in (result.get("observation") or {}).get("tree", "")
            passed = not failure and accepted and not witness_result["violations"]
            print(json.dumps({"passed": passed, "markerObservedInTarget": accepted,
                              "violations": witness_result["violations"], "actionFailure": failure}, indent=2))
            print("Also verify your sentence stayed intact in the foreground app. This sampler cannot prove that no sub-10ms window-order change occurred.")
            return 0 if passed else 1
        finally:
            stop.touch()
            if witness and witness.poll() is None:
                try:
                    witness.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    witness.terminate()
                    witness.wait(timeout=5)
            if not desk.stdin.closed:
                desk.stdin.close()
            desk.terminate()
            try:
                desk.wait(timeout=2)
            except subprocess.TimeoutExpired:
                desk.kill()
                desk.wait()


if __name__ == "__main__":
    sys.exit(main())
