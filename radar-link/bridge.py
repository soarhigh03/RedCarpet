#!/usr/bin/env python3
"""Bridge the board's lines into the page, for when the browser will not talk to the
device itself — Safari and Firefox have no Web Serial or Web Bluetooth, and a locked-down
Chrome may refuse both.

It does two small things: serves this folder over http://localhost so the page is in a
secure context, and forwards one source to every WebSocket client on port 8787. The page
reads that socket with the "Python bridge" transport.

    python3 bridge.py                                 # serve the page, no source
    python3 bridge.py --serial /dev/cu.usbmodem1101   # pyserial  (pip install pyserial)
    python3 bridge.py --ble RedCarpet                 # bleak     (pip install bleak)
    python3 bridge.py --file sample-log.csv --loop    # replay a saved log
    python3 bridge.py --synthetic                     # generate rows, no board

Only the --serial and --ble modes need a third-party package, and only when used.
"""

import argparse
import base64
import functools
import hashlib
import http.server
import math
import os
import random
import re
import socket
import struct
import sys
import threading
import time

WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HERE = os.path.dirname(os.path.abspath(__file__))

# Nordic UART Service, which is what the board exposes. ASCII arrives in 20-byte
# pieces on the notify characteristic and is joined back into lines on '\n'.
NUS_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
BLE_NAME = "ZYBO-RADAR"


def log(message):
    print(f"[bridge] {message}", flush=True)


def local_address(host):
    """The address to hand to someone else. Binding 0.0.0.0 says nothing about which
    address a teammate should type, so look up the one this machine uses outbound."""
    if host not in ("0.0.0.0", "::"):
        return host
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))      # reserved, never answers; no packet is sent
        return probe.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())
    finally:
        probe.close()


class LineJoiner:
    """Join the pieces a transport hands over back into lines.

    BLE delivers a row 20 bytes at a time, so one notification is almost never one line:
    a line spans several, and a notification can carry the end of one row and the start
    of the next. A serial read can split a line the same way when it times out mid-row.
    Everything is held until a '\\n' arrives, which is the only thing that ends a row.
    """

    LIMIT = 4096        # no newline in sight: stop growing rather than buffer forever

    def __init__(self):
        self.tail = ""

    def feed(self, chunk):
        """Take decoded text, return the complete lines it finished.

        Either terminator ends a row. A board that prints '\\r' alone would otherwise
        never finish a line here, and the buffer would fill with rows nobody saw."""
        self.tail += chunk
        parts = re.split(r"[\r\n]", self.tail)
        self.tail = parts.pop()
        if len(self.tail) > self.LIMIT:
            self.tail = self.tail[-512:]
        return [line.strip() for line in parts if line.strip()]


# ── A WebSocket server small enough to carry around ──────────────────────────
# Text frames, server to client only. Anything a client sends is read and dropped,
# except a close frame, which ends that client.

def _accept_key(key):
    return base64.b64encode(hashlib.sha1(key + WS_GUID).digest()).decode()


def _handshake(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(2048)
        if not chunk or len(data) > 16384:
            return False
        data += chunk
    headers = {}
    for line in data.split(b"\r\n")[1:]:
        if b":" in line:
            name, value = line.split(b":", 1)
            headers[name.strip().lower()] = value.strip()
    key = headers.get(b"sec-websocket-key")
    if not key:
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
        return False
    conn.sendall(
        b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        b"Sec-WebSocket-Accept: " + _accept_key(key).encode() + b"\r\n\r\n"
    )
    return True


def _text_frame(text):
    payload = text.encode("utf-8", "ignore")
    size = len(payload)
    if size < 126:
        head = struct.pack("!BB", 0x81, size)
    elif size < 65536:
        head = struct.pack("!BBH", 0x81, 126, size)
    else:
        head = struct.pack("!BBQ", 0x81, 127, size)
    return head + payload


class Hub:
    """Every connected page, and one method to send all of them a line.

    The radio allows one receiver, so this process is it. Fanning the lines out from
    here is what lets more than one person watch the same run."""

    def __init__(self, port, host="127.0.0.1"):
        self.port = port
        self.host = host
        self.clients = set()
        self.lock = threading.Lock()
        self.sent = 0

    def serve_forever(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((self.host, self.port))
        server.listen(16)
        log(f"websocket on ws://{local_address(self.host)}:{self.port}")
        while True:
            conn, _ = server.accept()
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        try:
            if not _handshake(conn):
                conn.close()
                return
        except OSError:
            conn.close()
            return
        with self.lock:
            self.clients.add(conn)
        log(f"page connected ({len(self.clients)} open)")
        try:
            while True:
                chunk = conn.recv(1024)          # drained; a close frame ends the loop
                if not chunk or (chunk[0] & 0x0F) == 0x8:
                    break
        except OSError:
            pass
        finally:
            self.drop(conn)

    def drop(self, conn):
        with self.lock:
            self.clients.discard(conn)
        try:
            conn.close()
        except OSError:
            pass
        log(f"page disconnected ({len(self.clients)} open)")

    def broadcast(self, line):
        frame = _text_frame(line.rstrip("\r\n") + "\n")
        with self.lock:
            targets = list(self.clients)
        for conn in targets:
            try:
                conn.sendall(frame)
            except OSError:
                self.drop(conn)
        self.sent += 1


# ── Sources ──────────────────────────────────────────────────────────────────

def from_serial(hub, port, baud):
    try:
        import serial                           # pip install pyserial
    except ImportError:
        sys.exit("pyserial is not installed. Try: pip install pyserial")
    log(f"opening {port} at {baud} baud")
    joiner = LineJoiner()                        # a timed-out read can split a row
    with serial.Serial(port, baud, timeout=1) as link:
        while True:
            raw = link.read(max(1, link.in_waiting))
            if not raw:
                continue
            for line in joiner.feed(raw.decode("ascii", "ignore")):
                hub.broadcast(line)


def from_ble(hub, name, notify_uuid):
    try:
        import asyncio
        from bleak import BleakClient, BleakScanner   # pip install bleak
    except ImportError:
        sys.exit("bleak is not installed. Try: pip install bleak")

    async def run():
        log(f"scanning for a BLE device matching {name!r}")
        device = await BleakScanner.find_device_by_filter(
            lambda d, _ad: bool(d.name and name.lower() in d.name.lower())
            or (d.address or "").lower() == name.lower(),
            timeout=15.0,
        )
        if device is None:
            sys.exit(f"No BLE device matched {name!r}. Is it powered and advertising, and "
                     f"is anything else already connected to it? The board takes one receiver.")
        log(f"connecting to {device.name or device.address}")
        joiner = LineJoiner()
        seen = {"lines": 0}

        def on_notify(_handle, payload):
            # ASCII arrives 20 bytes at a time, so a row spans several notifications.
            for line in joiner.feed(payload.decode("ascii", "ignore")):
                if seen["lines"] == 0:
                    log(f"first line: {line}")   # proof the reassembly produced a row
                seen["lines"] += 1
                hub.broadcast(line)

        async with BleakClient(device) as client:
            await client.start_notify(notify_uuid, on_notify)
            log(f"notifications started on {notify_uuid}")
            # A heartbeat, so a silent link looks different from a working one.
            ticks = 0
            while client.is_connected:
                await asyncio.sleep(0.5)
                ticks += 1
                if ticks % 10 == 0:
                    log(f"{seen['lines']} lines in, {len(hub.clients)} page(s) watching"
                        if seen["lines"] else "connected, but no lines yet — is the board sending?")
        log("BLE device disconnected")

    asyncio.run(run())


def from_file(hub, path, interval, loop):
    with open(path, "r", encoding="utf-8") as handle:
        lines = [line.strip() for line in handle if line.strip() and not line.lstrip().startswith("#")]
    if not lines:
        sys.exit(f"{path} has no rows in it.")
    log(f"replaying {path}: {len(lines)} lines, one every {interval * 1000:.0f} ms")
    while True:
        for line in lines:
            hub.broadcast(line)
            time.sleep(interval)
        if not loop:
            log("end of file")
            return


def from_synthetic(hub, interval, speed, fov, seed):
    """The same teaching model the page's synthetic feed uses: straight tracks, a
    constant command speed, and a closed-form crossing. Not a guidance model."""
    rng = random.Random(seed)
    half = fov / 2.0
    max_range = 30.0

    def spawn(idx, cls, low, high):
        bearing = math.radians(rng.uniform(-half * 0.82, half * 0.82))
        reach = max_range * rng.uniform(0.6, 0.95)
        px, py = reach * math.cos(bearing), reach * math.sin(bearing)
        aim = math.atan2(-py + rng.uniform(-7.5, 7.5), -px)
        pace = rng.uniform(low, high)
        return {"idx": idx, "cls": cls, "p": [px, py],
                "v": [math.cos(aim) * pace, math.sin(aim) * pace], "hidden": 0,
                "band": (low, high)}

    def crossing(p, v, pace):
        a = v[0] ** 2 + v[1] ** 2 - pace ** 2
        b = 2 * (p[0] * v[0] + p[1] * v[1])
        c = p[0] ** 2 + p[1] ** 2
        if abs(a) < 1e-9:
            return -c / b if b < -1e-9 else None
        disc = b * b - 4 * a * c
        if disc < 0:
            return None
        root = math.sqrt(disc)
        options = sorted(t for t in ((-b - root) / (2 * a), (-b + root) / (2 * a)) if t > 1e-4)
        return options[0] if options else None

    # The drone band straddles the command speed on purpose: a contact moving faster
    # than the interceptor cannot always be met, which is the sol = 0 chase case.
    tracks = [spawn(1, 2, speed * 0.6, speed * 1.8), spawn(2, 1, 0.6, 2.2)]
    frame = 0
    log(f"generating rows at {1 / interval:.0f} Hz, command speed {speed} m/s, seed {seed}")
    while True:
        frame = (frame + 1) % 65536
        rows = []
        for track in tracks:
            track["p"][0] += track["v"][0] * interval
            track["p"][1] += track["v"][1] * interval
            reach = math.hypot(*track["p"])
            bearing = math.degrees(math.atan2(track["p"][1], track["p"][0]))
            if reach > max_range or reach < 0.08 or abs(bearing) > half:
                track["hidden"] += 1
                if track["hidden"] > 12:
                    track.update(spawn(track["idx"], track["cls"], *track["band"]))
                continue
            track["hidden"] = 0

            range_mm = round(reach * 1000 + rng.uniform(-1.5, 1.5))
            bearing_cdeg = round((bearing + rng.uniform(-0.05, 0.05)) * 100)
            closing_mms = round(-((track["p"][0] * track["v"][0] + track["p"][1] * track["v"][1]) / reach) * 1000)

            ttg = crossing(track["p"], track["v"], speed)
            solved = ttg is not None and ttg < 30
            if solved:
                aim = [track["p"][0] + track["v"][0] * ttg, track["p"][1] + track["v"][1] * ttg]
            else:
                aim = list(track["p"])
            length = math.hypot(*aim) or 1.0
            wx = round(aim[0] / length * speed * 1000)
            wy = round(aim[1] / length * speed * 1000)
            cx, cy = wx + rng.randint(-2, 2), wy + rng.randint(-2, 2)
            rows.append(",".join(str(value) for value in [
                "G", frame, track["idx"], track["cls"], 1 if solved else 0,
                range_mm, bearing_cdeg, closing_mms, round(ttg * 1000) if solved else -1,
                wx, wy, cx, cy, round(math.degrees(math.atan2(cy, cx)) * 100)]))

        for row in rows or [f"G,{frame},-1"]:
            hub.broadcast(row)
        time.sleep(interval)


# ── Static files, so the page sits on http://localhost ───────────────────────

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def serve_http(port, host="127.0.0.1"):
    # Served from the parent folder, not this one, so the page can reach the shared
    # Pretendard file at ../public/fonts/. It falls back to a system face without it.
    root = os.path.dirname(HERE)
    handler = functools.partial(QuietHandler, directory=root)
    server = http.server.ThreadingHTTPServer((host, port), handler)
    log(f"page on http://{local_address(host)}:{port}/{os.path.basename(HERE)}/index.html")
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Forward the radar link into the Radar Link page.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--serial", metavar="PORT", help="serial port, e.g. /dev/cu.usbmodem1101 or COM5")
    source.add_argument("--ble", metavar="NAME", nargs="?", const=BLE_NAME,
                        help=f"BLE device name or address (bare --ble means {BLE_NAME})")
    source.add_argument("--file", metavar="PATH", help="replay a saved log")
    source.add_argument("--synthetic", action="store_true", help="generate rows with no board")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--notify", default=NUS_NOTIFY, help="BLE characteristic that notifies")
    parser.add_argument("--interval", type=float, default=0.1, help="seconds between generated or replayed lines")
    parser.add_argument("--loop", action="store_true", help="restart --file at the end")
    parser.add_argument("--speed", type=float, default=5.0, help="command speed for --synthetic, m/s")
    parser.add_argument("--fov", type=float, default=160.0, help="sensor field of view for --synthetic, degrees")
    parser.add_argument("--seed", type=int, default=20261011, help="repeatable --synthetic run")
    parser.add_argument("--ws-port", type=int, default=8787)
    parser.add_argument("--http-port", type=int, default=8080)
    parser.add_argument("--no-http", action="store_true", help="do not serve this folder")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to bind. Use 0.0.0.0 to let other machines on the "
                             "network read the stream; the default keeps it on this one")
    args = parser.parse_args()

    if args.host not in ("127.0.0.1", "localhost"):
        log(f"bound to {args.host}: anyone on this network can read the stream and open "
            f"the page. Stop the bridge when the run is over.")

    hub = Hub(args.ws_port, args.host)
    threading.Thread(target=hub.serve_forever, daemon=True).start()
    if not args.no_http:
        threading.Thread(target=serve_http, args=(args.http_port, args.host), daemon=True).start()

    if args.serial:
        runner = lambda: from_serial(hub, args.serial, args.baud)
    elif args.ble:
        runner = lambda: from_ble(hub, args.ble, args.notify)
    elif args.file:
        runner = lambda: from_file(hub, args.file, args.interval, args.loop)
    elif args.synthetic:
        runner = lambda: from_synthetic(hub, args.interval, args.speed, args.fov, args.seed)
    else:
        log("no source given — serving the page only. Add --serial, --ble, --file or --synthetic.")
        runner = lambda: [time.sleep(3600) for _ in iter(int, 1)]

    try:
        runner()
        while True:                              # a finished source still serves the page
            time.sleep(1)
    except KeyboardInterrupt:
        log(f"stopping after {hub.sent} lines")


if __name__ == "__main__":
    main()
