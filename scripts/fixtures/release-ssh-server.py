"""Loopback-only SSH/proxy fixture. Never executes received commands."""
import base64
import json
import os
import secrets
import select
import socket
import socketserver
import struct
import sys
import threading
import time
from pathlib import Path

import paramiko

secret = secrets.token_urlsafe(24)
host_key = paramiko.RSAKey.generate(2048)
metadata_path = Path(sys.argv[1])
counters = {"auth": 0, "socks": 0, "http": 0, "jump": 0, "shell": 0}
allowed_ports = set()


def exact(stream, length):
    value = b""
    while len(value) < length:
        chunk = stream.recv(length - len(value))
        if not chunk:
            raise EOFError()
        value += chunk
    return value


def connect_fixture(host, port):
    if host not in ("localhost", "127.0.0.1") or port not in allowed_ports:
        raise ValueError("destination outside fixture")
    return socket.create_connection(("127.0.0.1", port), 10)


def relay(left, right):
    try:
        while True:
            readable, _, _ = select.select([left, right], [], [], 15)
            for source in readable:
                data = source.recv(32768)
                if not data:
                    return
                (right if source is left else left).sendall(data)
    finally:
        left.close()
        right.close()


class SshPolicy(paramiko.ServerInterface):
    def __init__(self):
        self.forwards = {}
        self.commands = {}

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, password):
        if username == "acceptance" and secrets.compare_digest(password, secret):
            counters["auth"] += 1
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        if destination[0] not in ("localhost", "127.0.0.1") or destination[1] not in allowed_ports:
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        self.forwards[chanid] = destination
        return paramiko.OPEN_SUCCEEDED

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        return True

    def check_channel_window_change_request(self, channel, width, height, pixelwidth, pixelheight):
        return True

    def check_channel_shell_request(self, channel):
        self.commands[channel.chanid] = "shell"
        return True

    def check_channel_exec_request(self, channel, command):
        self.commands[channel.chanid] = "exec"
        return True


class SshHandler(socketserver.BaseRequestHandler):
    def handle(self):
        transport = paramiko.Transport(self.request)
        # This fixture has no DH modulus database; advertise a fixed-group KEX.
        transport.get_security_options().kex = ("diffie-hellman-group14-sha256",)
        policy = SshPolicy()
        transport.add_server_key(host_key)
        try:
            transport.start_server(server=policy)
            while transport.is_active():
                channel = transport.accept(1)
                if channel is None:
                    continue
                if channel.chanid in policy.forwards:
                    destination = policy.forwards[channel.chanid]
                    counters["jump"] += 1
                    threading.Thread(target=relay, args=(channel, connect_fixture(*destination)), daemon=True).start()
                else:
                    threading.Thread(target=self.serve_channel, args=(channel, policy), daemon=True).start()
        except (EOFError, OSError, paramiko.SSHException):
            pass
        finally:
            transport.close()

    @staticmethod
    def serve_channel(channel, policy):
        try:
            for _ in range(100):
                if channel.chanid in policy.commands:
                    break
                time.sleep(.02)
            if policy.commands.get(channel.chanid) == "exec":
                channel.sendall(b"SSH_ROUTE_PROOF\n")
                channel.send_exit_status(0)
                channel.close()
                return
            counters["shell"] += 1
            channel.sendall(b"SSH_ROUTE_PROOF\r\nfixture> ")
            while True:
                data = channel.recv(8192)
                if not data:
                    return
                channel.sendall(b"SSH_ECHO:" + data)
        except (OSError, EOFError):
            pass
        finally:
            channel.close()


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(15)
            first = exact(self.request, 1)
            if first == b"\x05":
                methods = exact(self.request, exact(self.request, 1)[0])
                if 2 not in methods:
                    return
                self.request.sendall(b"\x05\x02")
                exact(self.request, 1)
                user = exact(self.request, exact(self.request, 1)[0]).decode()
                password = exact(self.request, exact(self.request, 1)[0]).decode()
                if user != "acceptance" or not secrets.compare_digest(password, secret):
                    self.request.sendall(b"\x01\x01")
                    return
                self.request.sendall(b"\x01\x00")
                version, command, _, kind = exact(self.request, 4)
                if version != 5 or command != 1:
                    return
                host = socket.inet_ntoa(exact(self.request, 4)) if kind == 1 else exact(self.request, exact(self.request, 1)[0]).decode()
                port = struct.unpack("!H", exact(self.request, 2))[0]
                target = connect_fixture(host, port)
                self.request.sendall(b"\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00")
                counters["socks"] += 1
            else:
                header = first
                while b"\r\n\r\n" not in header and len(header) < 8192:
                    header += exact(self.request, 1)
                authorization = base64.b64encode(f"acceptance:{secret}".encode())
                if b"Basic " + authorization not in header:
                    self.request.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                    return
                address = header.split(b" ")[1].decode()
                host, port = address.rsplit(":", 1)
                target = connect_fixture(host, int(port))
                self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                counters["http"] += 1
            relay(self.request, target)
        except (OSError, EOFError, ValueError):
            pass


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


servers = [Server(("127.0.0.1", 0), handler) for handler in [SshHandler, SshHandler, ProxyHandler]]
ports = [server.server_address[1] for server in servers]
allowed_ports.update(ports[:2])
for server in servers:
    threading.Thread(target=server.serve_forever, daemon=True).start()
metadata_path.write_text(json.dumps({"pid": os.getpid(), "host": "127.0.0.1", "targetPort": ports[0], "jumpPort": ports[1], "proxyPort": ports[2], "password": secret}))
metadata_path.chmod(0o600)
print(json.dumps({"ready": True, "pid": os.getpid(), "ports": ports}), flush=True)
try:
    while True:
        metadata_path.with_suffix(".counts.json").write_text(json.dumps(counters))
        time.sleep(1)
finally:
    for server in servers:
        server.shutdown()
    metadata_path.unlink(missing_ok=True)
