import array
import base64
import ctypes
import ctypes.util
import errno
import fcntl
import ipaddress
import json
import os
import pathlib
import re
import select
import shutil
import signal
import socket
import ssl
import stat
import subprocess
import sys
import threading
import tempfile
import time
import urllib.parse


UID = 61001
HOME = "/home/agent"
REQUEST_LIMIT = 16 * 1024 * 1024
OUTPUT_LIMIT = 64 * 1024 * 1024
HEADER_LIMIT = 65536


def sealed_file(name, data):
    descriptor = os.memfd_create(name, os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
    try:
        with os.fdopen(os.dup(descriptor), "wb") as output:
            output.write(data)
        os.lseek(descriptor, 0, os.SEEK_SET)
        fcntl.fcntl(descriptor, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def socket_filter():
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise RuntimeError("Execution isolation requires libseccomp")
    lib = ctypes.CDLL(library)

    class Comparison(ctypes.Structure):
        _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_uint), ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]

    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Comparison)]
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    context = lib.seccomp_init(0x7FFF0000)
    if not context:
        raise RuntimeError("Unable to initialize execution syscall filter")
    descriptor = os.memfd_create("qm-execution-filter", os.MFD_CLOEXEC)
    try:
        for syscall in [b"socket", b"socketpair"]:
            for family in [socket.AF_UNIX, socket.AF_VSOCK]:
                number = lib.seccomp_syscall_resolve_name(syscall)
                comparison = Comparison(0, 4, family, 0)
                if number < 0 or lib.seccomp_rule_add_array(context, 0x50000 | errno.EPERM, number, 1, ctypes.byref(comparison)) != 0:
                    raise RuntimeError("Unable to restrict execution control sockets")
        number = lib.seccomp_syscall_resolve_name(b"io_uring_setup")
        if number < 0 or lib.seccomp_rule_add_array(context, 0x50000 | errno.EPERM, number, 0, None) != 0:
            raise RuntimeError("Unable to restrict execution asynchronous syscalls")
        if lib.seccomp_export_bpf(context, descriptor) != 0:
            raise RuntimeError("Unable to export execution syscall filter")
        os.lseek(descriptor, 0, os.SEEK_SET)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise
    finally:
        lib.seccomp_release(context)


def parse_origin(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("Invalid HTTP origin")
    host = parsed.hostname.lower().rstrip(".")
    if not host or any(character in host for character in "\\% \t\r\n"):
        raise ValueError("Invalid HTTP host")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if not 1 <= port <= 65535:
        raise ValueError("Invalid HTTP port")
    return parsed, (parsed.scheme, host, port)


def public_address(value):
    address = ipaddress.ip_address(value.split("%", 1)[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast and not address.is_reserved and not address.is_unspecified


def relay(left, right, stop):
    peers = {left: right, right: left}
    for connection in peers:
        connection.settimeout(1)
    while peers and not stop.is_set():
        readable, _, _ = select.select(list(peers), [], [], 0.25)
        for source in readable:
            data = source.recv(65536)
            if data:
                peers[source].sendall(data)
            else:
                try:
                    peers[source].shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                del peers[source]


class Broker:
    def __init__(self, control, trusted_origins, upstream_proxy=None):
        self.control = control
        self.trusted = set()
        for value in trusted_origins:
            parsed, origin = parse_origin(value)
            if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
                raise ValueError("Trusted routes must be exact HTTP origins")
            self.trusted.add(origin)
        self.upstream = None
        if upstream_proxy is not None:
            parsed = urllib.parse.urlsplit(upstream_proxy)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
                raise ValueError("Unsupported upstream proxy URL")
            self.upstream = parsed
        self.stop = threading.Event()
        self.slots = threading.BoundedSemaphore(64)
        self.lock = threading.Lock()
        self.connections = {control}
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def track(self, connection):
        with self.lock:
            if self.stop.is_set():
                connection.close()
                raise RuntimeError("Execution has ended")
            self.connections.add(connection)
        return connection

    def close_connection(self, connection):
        with self.lock:
            self.connections.discard(connection)
        connection.close()

    def start(self):
        self.thread.start()

    def close(self):
        self.stop.set()
        with self.lock:
            connections = list(self.connections)
            self.connections.clear()
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        if self.thread.ident is not None:
            self.thread.join(timeout=2)

    def serve(self):
        try:
            while not self.stop.is_set() and self.control.recv(1):
                if not self.slots.acquire(blocking=False):
                    self.control.send(b"E")
                    continue
                left, right = socket.socketpair()
                try:
                    self.track(left)
                    self.control.sendmsg([b"S"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [right.fileno()]))])
                    threading.Thread(target=self.forward, args=(left,), daemon=True).start()
                except BaseException:
                    self.close_connection(left)
                    self.slots.release()
                    raise
                finally:
                    right.close()
        except (OSError, RuntimeError):
            pass

    def upstream_connect(self, origin):
        proxy = self.upstream
        connection = self.track(socket.create_connection((proxy.hostname, proxy.port or (443 if proxy.scheme == "https" else 80)), timeout=10))
        try:
            if proxy.scheme == "https":
                context = ssl.create_default_context()
                context.minimum_version = ssl.TLSVersion.TLSv1_2
                secured = context.wrap_socket(connection, server_hostname=proxy.hostname)
                with self.lock:
                    self.connections.discard(connection)
                connection = self.track(secured)
            host = origin[1]
            authority = ("[" + host + "]" if ":" in host else host) + ":" + str(origin[2])
            headers = ["CONNECT " + authority + " HTTP/1.1", "Host: " + authority]
            if proxy.username is not None:
                credential = urllib.parse.unquote(proxy.username) + ":" + urllib.parse.unquote(proxy.password or "")
                headers.append("Proxy-Authorization: Basic " + base64.b64encode(credential.encode()).decode())
            connection.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("ascii"))
            response = b""
            while not response.endswith(b"\r\n\r\n"):
                part = connection.recv(1)
                if not part or len(response) >= HEADER_LIMIT:
                    raise OSError("Upstream proxy connection failed")
                response += part
            fields = response.split(b"\r\n", 1)[0].split(b" ")
            if len(fields) < 2 or fields[1] != b"200":
                raise OSError("Upstream proxy rejected destination")
            return connection
        except BaseException:
            self.close_connection(connection)
            raise

    def connect(self, origin):
        scheme, host, port = origin
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not addresses or (origin not in self.trusted and any(not public_address(address[4][0]) for address in addresses)):
            raise PermissionError("Private and management destinations are prohibited")
        if self.upstream is not None and origin not in self.trusted:
            return self.upstream_connect(origin)
        for family, kind, protocol, _, address in addresses:
            connection = self.track(socket.socket(family, kind, protocol))
            connection.settimeout(10)
            try:
                connection.connect(address)
                return connection
            except OSError:
                self.close_connection(connection)
        raise OSError("Destination is unreachable")

    def forward(self, connection):
        upstream = None
        try:
            connection.settimeout(10)
            data = b""
            while b"\r\n\r\n" not in data:
                part = connection.recv(4096)
                if not part:
                    return
                data += part
                if len(data) > HEADER_LIMIT:
                    raise ValueError("HTTP request header too large")
            header, tail = data.split(b"\r\n\r\n", 1)
            lines = header.decode("iso-8859-1").split("\r\n")
            method, target, version = lines[0].split(" ")
            if not re.fullmatch(r"[A-Z]+", method) or version not in ("HTTP/1.0", "HTTP/1.1"):
                raise ValueError("Invalid HTTP request")
            if method == "CONNECT":
                parsed, origin = parse_origin("https://" + target)
                if parsed.path or parsed.query or parsed.fragment or parsed.port is None:
                    raise ValueError("Invalid CONNECT authority")
                origin = next((trusted for trusted in self.trusted if trusted[1:] == origin[1:]), origin)
                upstream = self.connect(origin)
                connection.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            else:
                parsed, origin = parse_origin(target)
                if origin[0] != "http" or parsed.fragment:
                    raise ValueError("HTTP proxy requires an absolute HTTP URL")
                headers = []
                for line in lines[1:]:
                    if ":" not in line or line.startswith((" ", "\t")):
                        raise ValueError("Invalid HTTP header")
                    key, value = line.split(":", 1)
                    if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key) or "\r" in value or "\n" in value:
                        raise ValueError("Invalid HTTP header")
                    headers.append((key, value.strip()))
                lengths = [value for key, value in headers if key.lower() == "content-length"]
                transfers = [value.lower() for key, value in headers if key.lower() == "transfer-encoding"]
                if len(lengths) > 1 or (lengths and (not lengths[0].isdigit() or transfers)) or (transfers and transfers != ["chunked"]):
                    raise ValueError("Ambiguous HTTP body framing")
                forbidden = {"host", "connection", "proxy-connection", "proxy-authorization"}
                for key, value in headers:
                    if key.lower() == "connection":
                        forbidden.update(item.strip().lower() for item in value.split(","))
                if forbidden.intersection({"content-length", "transfer-encoding"}):
                    raise ValueError("Invalid connection headers")
                host = origin[1]
                authority = f"[{host}]" if ":" in host else host
                if origin[2] != 80:
                    authority += ":" + str(origin[2])
                rewritten = [f"{method} {parsed.path or '/'}{'?' + parsed.query if parsed.query else ''} {version}", "Host: " + authority, "Connection: close"]
                rewritten.extend(key + ": " + value for key, value in headers if key.lower() not in forbidden)
                upstream = self.connect(origin)
                upstream.sendall(("\r\n".join(rewritten) + "\r\n\r\n").encode("iso-8859-1"))
            if tail:
                upstream.sendall(tail)
            relay(connection, upstream, self.stop)
        except PermissionError:
            try:
                connection.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
        except (OSError, ValueError, RuntimeError):
            try:
                connection.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
        finally:
            if upstream is not None:
                self.close_connection(upstream)
            self.close_connection(connection)
            self.slots.release()


def validate_request(request):
    if not isinstance(request, dict) or not isinstance(request.get("command"), str) or "\x00" in request["command"]:
        raise ValueError("Execution requires a command string")
    workspace = request.get("workspace")
    if not isinstance(workspace, str) or not os.path.isabs(workspace) or os.path.realpath(workspace) != workspace or not os.path.isdir(workspace):
        raise ValueError("Workspace must be an existing canonical absolute directory")
    if workspace in ("/", "/root", "/home") or os.path.commonpath([workspace, HOME]) in (workspace, HOME) or any(workspace == path or workspace.startswith(path + "/") for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/sys", "/dev", "/run", "/opt"]):
        raise ValueError("Workspace overlaps protected runtime paths")
    cwd = request.get("cwd", workspace)
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or os.path.commonpath([workspace, os.path.realpath(cwd)]) != workspace:
        raise ValueError("Working directory must remain inside the workspace")
    timeout = request.get("timeoutMs")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 86400000:
        raise ValueError("Execution requires a bounded timeoutMs")
    env = request.get("env", {})
    if not isinstance(env, dict) or any(not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) or "\x00" in value for key, value in env.items()):
        raise ValueError("Invalid execution environment")
    files = request.get("files", [])
    if not isinstance(files, list):
        raise ValueError("Invalid credential files")
    paths = set()
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("contentBase64"), str):
            raise ValueError("Invalid credential file")
        path = entry["path"]
        if not path or len(path) > 4096 or path.startswith("/") or "\x00" in path or any(part in ("", ".", "..") for part in path.split("/")) or path in paths:
            raise ValueError("Credential paths must be unique relative home paths")
        paths.add(path)
        base64.b64decode(entry["contentBase64"], validate=True)
    for path in paths:
        parent = path
        while "/" in parent:
            parent = parent.rsplit("/", 1)[0]
            if parent in paths:
                raise ValueError("Credential file paths overlap")
    trusted = request.get("trustedHttpOrigins", [])
    if not isinstance(trusted, list) or any(not isinstance(value, str) for value in trusted):
        raise ValueError("Invalid trusted HTTP origins")
    upstream = request.get("upstreamProxy")
    if upstream is not None and not isinstance(upstream, str):
        raise ValueError("Invalid upstream proxy")
    return dict(request, workspace=workspace, cwd=cwd, env=env, files=files, trustedHttpOrigins=trusted, upstreamProxy=upstream)


def verify_worker():
    fields = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
    if int(fields["CapEff"].strip(), 16) or int(fields["CapPrm"].strip(), 16) or ctypes.CDLL(None).prctl(39, 0, 0, 0, 0) != 1:
        raise RuntimeError("Execution privileges were not dropped")
    for family in [socket.AF_UNIX, socket.AF_VSOCK]:
        try:
            connection = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            if error.errno != errno.EPERM:
                raise RuntimeError("Execution socket filter is not enforced") from error
        else:
            connection.close()
            raise RuntimeError("Execution socket filter is not enforced")


    try:
        pair = socket.socketpair(socket.AF_UNIX)
    except OSError as error:
        if error.errno != errno.EPERM:
            raise RuntimeError("Execution socketpair filter is not enforced") from error
    else:
        for connection in pair:
            connection.close()
        raise RuntimeError("Execution socketpair filter is not enforced")
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    number = lib.seccomp_syscall_resolve_name(b"io_uring_setup")
    libc = ctypes.CDLL(None, use_errno=True)
    parameters = ctypes.create_string_buffer(256)
    descriptor = libc.syscall(number, 1, ctypes.byref(parameters))
    if descriptor >= 0:
        os.close(descriptor)
    if number < 0 or descriptor != -1 or ctypes.get_errno() != errno.EPERM:
        raise RuntimeError("Execution asynchronous syscall filter is not enforced")


def worker(control_fd):
    verify_worker()
    request = json.loads(pathlib.Path("/run/qm-request.json").read_bytes())
    os.unlink("/run/qm-request.json")
    for relative in request["filePaths"]:
        path = pathlib.Path(HOME, relative)
        data = path.read_bytes()
        descriptor, temporary = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as target:
                target.write(data)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    os.umask(0o002)
    control = socket.socket(fileno=control_fd)
    os.set_inheritable(control_fd, False)
    control_lock = threading.Lock()
    slots = threading.BoundedSemaphore(64)
    stop = threading.Event()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(64)
        listener.settimeout(0.5)
        proxy = "http://127.0.0.1:" + str(listener.getsockname()[1])

        def connection_loop(connection):
            stream = None
            try:
                with control_lock:
                    control.sendall(b"C")
                    message, ancillary, flags, _ = control.recvmsg(1, socket.CMSG_SPACE(array.array("i").itemsize))
                if message != b"S" or flags & socket.MSG_CTRUNC:
                    raise RuntimeError("Execution proxy capacity exceeded")
                descriptors = array.array("i")
                for level, kind, content in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        descriptors.frombytes(content[:len(content) - len(content) % descriptors.itemsize])
                if len(descriptors) != 1:
                    for descriptor in descriptors:
                        os.close(descriptor)
                    raise RuntimeError("Invalid execution proxy descriptor")
                stream = socket.socket(fileno=descriptors[0])
                os.set_inheritable(stream.fileno(), False)
                relay(connection, stream, stop)
            except (OSError, RuntimeError):
                pass
            finally:
                connection.close()
                if stream is not None:
                    stream.close()
                slots.release()

        def serve():
            while not stop.is_set():
                try:
                    connection, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                if slots.acquire(blocking=False):
                    threading.Thread(target=connection_loop, args=(connection,), daemon=True).start()
                else:
                    connection.close()

        threading.Thread(target=serve, daemon=True).start()
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", **request["env"], "HOME": HOME, "TMPDIR": "/tmp", "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy, "all_proxy": proxy, "NO_PROXY": "", "no_proxy": ""}
        for key in ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"]:
            env.setdefault(key, "/run/qm-ca-bundle.pem")
        try:
            return subprocess.call(["/bin/sh", "-c", request["command"]], cwd=request["cwd"], env=env)
        finally:
            stop.set()
            control.close()


def launch(request, stream):
    if os.geteuid() != 0:
        raise RuntimeError("Execution supervisor requires a trusted root process")
    for binary in ["bwrap", "setpriv", "unshare"]:
        if not shutil.which(binary):
            raise RuntimeError("Execution isolation dependency missing: " + binary)
    descriptors = []
    parent, child = socket.socketpair()
    broker = Broker(parent, request["trustedHttpOrigins"], request["upstreamProxy"])
    process = None
    try:
        filter_fd = socket_filter()
        descriptors.append(filter_fd)
        private_request = {key: request[key] for key in ["command", "cwd", "env"]}
        private_request["filePaths"] = [entry["path"] for entry in request["files"]]
        request_fd = sealed_file("qm-execution-request", json.dumps(private_request).encode())
        descriptors.append(request_fd)
        fields = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
        privileged = int(fields["CapEff"].strip(), 16) & ((1 << 21) | (1 << 12)) == ((1 << 21) | (1 << 12))
        profile = ["--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts"] if privileged else ["--unshare-all", "--uid", "0", "--gid", "0"]
        args = [shutil.which("bwrap"), *profile, "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--seccomp", str(filter_fd)]
        if privileged:
            args += ["--cap-add", "CAP_SETUID", "--cap-add", "CAP_SETGID", "--cap-add", "CAP_SETPCAP"]
        for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ssl/certs", "/etc/pki/tls/certs", "/etc/ld.so.cache", "/etc/localtime", "/opt/agent-venv"]:
            if os.path.exists(path):
                args += ["--ro-bind", path, path]
        args += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home", "--perms", "0777", "--dir", HOME, "--perms", "0777", "--dir", "/run", "--perms", "0444", "--file", str(request_fd), "/run/qm-request.json", "--dir", "/opt", "--ro-bind", os.path.realpath(__file__), "/opt/qm-execution-supervisor.py", "--bind", request["workspace"], request["workspace"], "--chdir", request["cwd"], "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", HOME]
        ca_candidates = [ssl.get_default_verify_paths().cafile, "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"]
        ca_path = next((path for path in ca_candidates if path and os.path.isfile(path)), None)
        if ca_path is None:
            raise RuntimeError("Execution isolation requires a trusted CA bundle")
        ca_fd = sealed_file("qm-execution-ca", pathlib.Path(ca_path).read_bytes())
        descriptors.append(ca_fd)
        args += ["--perms", "0444", "--file", str(ca_fd), "/run/qm-ca-bundle.pem"]
        directories = set()
        for entry in request["files"]:
            destination = HOME + "/" + entry["path"]
            for directory in reversed(pathlib.PurePosixPath(destination).parents):
                value = str(directory)
                if value.startswith(HOME + "/") and value not in directories:
                    args += ["--perms", "0777", "--dir", value]
                    directories.add(value)
            descriptor = sealed_file("qm-execution-credential", base64.b64decode(entry["contentBase64"], validate=True))
            descriptors.append(descriptor)
            args += ["--perms", "0666", "--file", str(descriptor), destination]
        args += ["--"]
        if privileged:
            args += ["setpriv", f"--reuid={UID}", f"--regid={UID}", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"]
        args += [os.path.realpath(sys.executable), "/opt/qm-execution-supervisor.py", "--worker", str(child.fileno())]
        if not privileged:
            if "gvisor" in os.uname().release:
                args = ["unshare", "--user", "--map-root-user", "--net", *args]
                delimiter = args.index("--")
                args[delimiter:delimiter] = ["--share-net"]
            args = ["setpriv", f"--reuid={UID}", f"--regid={UID}", "--clear-groups", "--no-new-privs", *args]
        broker.start()
        process = subprocess.Popen(args, stdin=None if stream else subprocess.DEVNULL, stdout=None if stream else subprocess.PIPE, stderr=None if stream else subprocess.PIPE, pass_fds=(*descriptors, child.fileno()), start_new_session=True)
        child.close()
        for descriptor in descriptors:
            os.close(descriptor)
        descriptors.clear()
        timeout = request["timeoutMs"] / 1000
        timed_out = False
        stdout = b""
        stderr = b""
        if stream:
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                process.kill()
                process.wait(timeout=5)
        else:
            outputs = {process.stdout: bytearray(), process.stderr: bytearray()}
            open_streams = set(outputs)
            deadline = time.monotonic() + timeout
            exceeded = False
            while open_streams:
                if time.monotonic() >= deadline:
                    timed_out = True
                    process.kill()
                    break
                ready, _, _ = select.select(list(open_streams), [], [], min(0.2, max(0, deadline - time.monotonic())))
                for output in ready:
                    data = os.read(output.fileno(), 65536)
                    if not data:
                        open_streams.remove(output)
                    else:
                        outputs[output].extend(data)
                        if sum(len(value) for value in outputs.values()) > OUTPUT_LIMIT:
                            exceeded = True
                            process.kill()
                            break
                if exceeded:
                    break
            try:
                process.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
                process.kill()
                process.wait(timeout=5)
            stdout = bytes(outputs[process.stdout])
            stderr = bytes(outputs[process.stderr])
            if exceeded:
                raise RuntimeError("Execution output exceeded 64 MiB limit")
        return {"stdout": stdout.decode("utf-8", errors="replace"), "stderr": stderr.decode("utf-8", errors="replace"), "code": 124 if timed_out else (128 - process.returncode if process.returncode < 0 else process.returncode), "timedOut": timed_out}
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        child.close()
        broker.close()
        for descriptor in descriptors:
            os.close(descriptor)


def read_request(path):
    if path is None:
        data = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    else:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError("Request file must be root-owned mode 0600")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                data = source.read(REQUEST_LIMIT + 1)
            os.unlink(path)
        finally:
            os.close(descriptor)
    if len(data) > REQUEST_LIMIT:
        raise ValueError("Execution request too large")
    return validate_request(json.loads(data))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        return worker(int(sys.argv[2]))
    stream = "--stream" in sys.argv[1:]
    arguments = [argument for argument in sys.argv[1:] if argument != "--stream"]
    if arguments and (len(arguments) != 2 or arguments[0] != "--request"):
        raise ValueError("Usage: execution-supervisor.py [--request PATH] [--stream]")
    if stream and not arguments:
        raise ValueError("Streaming execution requires a request file")
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    result = launch(read_request(arguments[1] if arguments else None), stream)
    if not stream:
        print(json.dumps(result), flush=True)
    return result["code"] if stream else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        if "--stream" in sys.argv or "--worker" in sys.argv:
            print("Execution isolation failed: " + str(error), file=sys.stderr, flush=True)
        else:
            print(json.dumps({"stdout": "", "stderr": "Execution isolation failed: " + str(error), "code": 125, "timedOut": False}), flush=True)
        sys.exit(125)
