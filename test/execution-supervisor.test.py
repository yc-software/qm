import base64
import http.server
import importlib.util
import json
import os
import pathlib
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import socketserver
import time
import unittest
import uuid
from unittest import mock


SUPERVISOR = pathlib.Path(os.environ.get("QM_SUPERVISOR_PATH", pathlib.Path(__file__).resolve().parents[1] / "src/sandbox/execution-supervisor.py"))
spec = importlib.util.spec_from_file_location("supervisor", SUPERVISOR)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class ValidationTests(unittest.TestCase):
    def test_private_addresses_include_mapped_ipv6_multicast_and_metadata(self):
        for address in ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "::ffff:127.0.0.1", "224.0.0.1", "ff02::1", "0.0.0.0"]:
            self.assertFalse(supervisor.public_address(address), address)
        self.assertTrue(supervisor.public_address("8.8.8.8"))

    def test_mixed_dns_answer_is_rejected_before_connect(self):
        parent, child = socket.socketpair()
        broker = supervisor.Broker(parent, [])
        try:
            with mock.patch.object(supervisor.socket, "getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]):
                with self.assertRaises(PermissionError):
                    broker.connect(("https", "example.com", 443))
        finally:
            child.close()
            broker.close()

    def test_upstream_proxy_keeps_authority_and_authentication_in_parent(self):
        seen = []
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                data = b""
                while b"\r\n\r\n" not in data:
                    data += self.request.recv(1024)
                seen.append(data)
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\nupstream")
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        parent, child = socket.socketpair()
        broker = supervisor.Broker(parent, [], f"http://test:synthetic-password@127.0.0.1:{server.server_address[1]}")
        original = socket.getaddrinfo
        def resolve(host, port, *args, **kwargs):
            if host == "public.example":
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]
            return original(host, port, *args, **kwargs)
        try:
            with mock.patch.object(supervisor.socket, "getaddrinfo", side_effect=resolve):
                connection = broker.connect(("https", "public.example", 443))
                self.assertEqual(connection.recv(8), b"upstream")
                broker.close_connection(connection)
            self.assertIn(b"CONNECT public.example:443 HTTP/1.1", seen[0])
            self.assertIn(b"Proxy-Authorization: Basic " + base64.b64encode(b"test:synthetic-password"), seen[0])
        finally:
            child.close()
            broker.close()
            server.shutdown()
            server.server_close()

    def test_request_paths_and_environment_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = os.path.realpath(directory)
            valid = {"command": "true", "workspace": workspace, "timeoutMs": 1000}
            for changes in [{"workspace": "/"}, {"cwd": "/"}, {"files": [{"path": "../escape", "contentBase64": ""}]}, {"files": [{"path": "a", "contentBase64": ""}, {"path": "a/b", "contentBase64": ""}]}, {"env": {"A": "x\x00y"}}, {"timeoutMs": float("nan")}]:
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    supervisor.validate_request({**valid, **changes})


@unittest.skipUnless(os.environ.get("QM_SUPERVISOR_LIVE") == "1", "Requires disposable root Linux namespace test environment")
class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="qm-supervisor-test-")
        self.workspace = pathlib.Path(self.directory.name)
        self.workspace.chmod(0o2770)
        os.chown(self.workspace, 0, supervisor.UID)
        self.base = {"workspace": str(self.workspace), "timeoutMs": 10000}

    def tearDown(self):
        self.directory.cleanup()

    def execute(self, command, **kwargs):
        completed = subprocess.run([sys.executable, "-I", str(SUPERVISOR)], input=json.dumps({**self.base, "command": command, **kwargs}), text=True, capture_output=True, timeout=30)
        result = json.loads(completed.stdout)
        self.assertEqual(completed.stderr, "")
        return result

    def python(self, source):
        return shlex.quote(sys.executable) + " -c " + shlex.quote(source)

    def test_output_environment_home_and_workspace(self):
        token = "synthetic-" + uuid.uuid4().hex
        command = self.python("import os,pathlib,sys; assert pathlib.Path(os.environ['HOME']+'/.auth/token').read_text()==os.environ['TOKEN']; assert pathlib.Path(os.environ['HOME']+'/.auth/token').stat().st_mode & 0o777 == 0o600; assert os.environ.get('HOST_SECRET') is None; pathlib.Path('saved').write_text('ok'); sys.stdout.buffer.write(b'alpha\\x00omega'); sys.stderr.write('exact stderr'); sys.exit(7)")
        previous = os.environ.get("HOST_SECRET")
        os.environ["HOST_SECRET"] = "ambient-must-not-leak"
        try:
            result = self.execute(command, env={"TOKEN": token}, files=[{"path": ".auth/token", "contentBase64": base64.b64encode(token.encode()).decode()}])
        finally:
            if previous is None:
                os.environ.pop("HOST_SECRET", None)
            else:
                os.environ["HOST_SECRET"] = previous
        self.assertEqual(result, {"stdout": "alpha\x00omega", "stderr": "exact stderr", "code": 7, "timedOut": False})
        self.assertEqual((self.workspace / "saved").read_text(), "ok")
        self.assertEqual((self.workspace / "saved").stat().st_uid, supervisor.UID)
        next_run = self.execute("test ! -e \"$HOME/.auth/token\"")
        self.assertEqual(next_run["code"], 0, next_run)

    def test_sibling_cannot_read_live_credential_or_ambient_processes(self):
        token = "synthetic-" + uuid.uuid4().hex
        holder_command = self.python("import pathlib,time; pathlib.Path('ready').write_text('ready'); time.sleep(2)")
        holder = subprocess.Popen([sys.executable, "-I", str(SUPERVISOR)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        holder.stdin.write(json.dumps({**self.base, "command": holder_command, "env": {"PRIVATE_TOKEN": token}, "files": [{"path": ".secret", "contentBase64": base64.b64encode(token.encode()).decode()}]}))
        holder.stdin.close()
        try:
            deadline = time.monotonic() + 5
            while not (self.workspace / "ready").exists() and holder.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue((self.workspace / "ready").exists())
            attacker = self.execute(self.python("import pathlib,os; assert not pathlib.Path(os.environ['HOME']+'/.secret').exists(); data=[]; [data.append(p.read_bytes()) for p in pathlib.Path('/proc').glob('[0-9]*/environ') if p.is_file()]; assert not any(b'PRIVATE_TOKEN=' in d for d in data)"))
            self.assertEqual(attacker["code"], 0, attacker)
        finally:
            holder.kill()
            holder.wait(timeout=5)
            holder.stdout.close()
            holder.stderr.close()

    def test_streaming_file_consumed_and_stdio_exact(self):
        path = self.workspace / "request.json"
        path.write_text(json.dumps({**self.base, "command": "cat; printf error >&2; exit 4"}))
        path.chmod(0o600)
        completed = subprocess.run([sys.executable, "-I", str(SUPERVISOR), "--request", str(path), "--stream"], input=b"streamed\x00input", capture_output=True, timeout=15)
        self.assertFalse(path.exists())
        self.assertEqual(completed.returncode, 4, completed.stderr)
        self.assertEqual(completed.stdout, b"streamed\x00input")
        self.assertEqual(completed.stderr, b"error")

    def test_request_file_symlink_and_permissions_rejected(self):
        path = self.workspace / "request.json"
        path.write_text(json.dumps({**self.base, "command": "touch executed"}))
        path.chmod(0o644)
        completed = subprocess.run([sys.executable, "-I", str(SUPERVISOR), "--request", str(path)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 125)
        self.assertFalse((self.workspace / "executed").exists())
        path.chmod(0o600)
        link = self.workspace / "link"
        link.symlink_to(path)
        completed = subprocess.run([sys.executable, "-I", str(SUPERVISOR), "--request", str(link)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 125)
        self.assertTrue(path.exists())

    def test_timeout_and_detached_children_are_terminated(self):
        marker = "qm-detached-" + uuid.uuid4().hex
        command = self.python("import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'," + repr(marker) + "],start_new_session=True); print('started',flush=True); time.sleep(60)")
        result = self.execute(command, timeoutMs=500)
        self.assertEqual(result["code"], 124, result)
        self.assertTrue(result["timedOut"])
        self.assertIn("started", result["stdout"])
        time.sleep(0.1)
        survivors = []
        for path in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
            try:
                if marker.encode() in path.read_bytes():
                    survivors.append(path.parent.name)
            except OSError:
                pass
        for pid in survivors:
            os.kill(int(pid), signal.SIGKILL)
        self.assertEqual(survivors, [])

    def test_killed_supervisor_reaps_execution_namespace(self):
        marker = "qm-killed-" + uuid.uuid4().hex
        command = self.python("import pathlib,time;pathlib.Path('kill-ready').write_text('ready');time.sleep(60)") + " " + marker
        process = subprocess.Popen([sys.executable, "-I", str(SUPERVISOR)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process.stdin.write(json.dumps({**self.base, "command": command}))
        process.stdin.close()
        try:
            deadline = time.monotonic() + 5
            while not (self.workspace / "kill-ready").exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue((self.workspace / "kill-ready").exists())
            process.kill()
            process.wait(timeout=5)
            time.sleep(0.2)
            survivors = []
            for path in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
                try:
                    if marker.encode() in path.read_bytes():
                        survivors.append(path.parent.name)
                except OSError:
                    pass
            for pid in survivors:
                os.kill(int(pid), signal.SIGKILL)
            self.assertEqual(survivors, [])
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()

    def test_upstream_rejection_does_not_fall_back_or_expose_password(self):
        seen = []
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                data = b""
                while b"\r\n\r\n" not in data:
                    data += self.request.recv(1024)
                seen.append(data)
                self.request.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        proxy = f"http://test:synthetic-proxy-password@127.0.0.1:{server.server_address[1]}"
        try:
            result = self.execute("env; curl -sS --max-time 3 https://8.8.8.8/", upstreamProxy=proxy)
            self.assertNotEqual(result["code"], 0, result)
            self.assertIn("502", result["stderr"])
            self.assertNotIn("synthetic-proxy-password", result["stdout"] + result["stderr"])
            self.assertTrue(seen)
        finally:
            server.shutdown()
            server.server_close()

    def test_private_network_denied_and_exact_trusted_origin_forwarded(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(self.headers["Host"].encode() + b":" + body)
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            denied = self.execute(f"curl -sS -o /dev/null -w '%{{http_code}}' {origin}/")
            self.assertEqual(denied["stdout"], "403", denied)
            allowed = self.execute(f"curl -sS -X POST -H 'Host: misleading' --data-binary payload {origin}/", trustedHttpOrigins=[origin])
            self.assertEqual(allowed["stdout"], f"127.0.0.1:{server.server_port}:payload", allowed)
            parallel = self.execute(f"for i in 1 2 3 4; do curl -sS -X POST --data-binary payload {origin}/ & done; wait", trustedHttpOrigins=[origin])
            self.assertEqual(parallel["stdout"].count(":payload"), 4, parallel)
            direct = self.execute(self.python(f"import socket; s=socket.socket(); s.settimeout(.3); assert s.connect_ex(('127.0.0.1',{server.server_port})) != 0"), trustedHttpOrigins=[origin])
            self.assertEqual(direct["code"], 0, direct)
            wrong_scheme = self.execute(f"curl -sS -o /dev/null https://127.0.0.1:{server.server_port}/", trustedHttpOrigins=[origin])
            self.assertNotEqual(wrong_scheme["code"], 0, wrong_scheme)
            tunneled = self.execute(f"curl -sS --proxytunnel -X POST --data-binary payload {origin}/", trustedHttpOrigins=[origin])
            self.assertEqual(tunneled["code"], 0, tunneled)
            self.assertEqual(tunneled["stdout"], f"127.0.0.1:{server.server_port}:payload", tunneled)
            other_port = 1 if server.server_port != 1 else 2
            denied_tunnel = self.execute(f"curl -sS --proxytunnel http://127.0.0.1:{other_port}/", trustedHttpOrigins=[origin])
            self.assertNotEqual(denied_tunnel["code"], 0, denied_tunnel)
            self.assertIn("403", denied_tunnel["stderr"])
        finally:
            server.shutdown()
            server.server_close()

    @unittest.skipUnless(os.environ.get("QM_SUPERVISOR_PUBLIC_NETWORK") == "1", "Requires public Internet")
    def test_public_https_via_proxy(self):
        result = self.execute("curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://example.com/", timeoutMs=20000)
        self.assertEqual(result["code"], 0, result)
        self.assertEqual(result["stdout"], "200", result)


if __name__ == "__main__":
    unittest.main()
