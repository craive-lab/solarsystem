#!/usr/bin/env python3
"""
Zero-dependency OSC monitor for the solar system demo.

Point the server at this and you can see the stream without installing anything:

    python tools/osc-monitor.py                  # live table on udp 57120
    python tools/osc-monitor.py --port 9000      # a different port
    python tools/osc-monitor.py --raw            # print every message instead
    python tools/osc-monitor.py --host 0.0.0.0   # accept from another machine

Then start the server with a matching destination:

    java -jar target/solarsystem.jar --osc-port 57120

Only the standard library is used, so this doubles as a compact reference implementation
of OSC 1.0 decoding.
"""

import argparse
import socket
import struct
import sys
import time

# ----------------------------------------------------------------- OSC decoding


def _padded(n):
    """Length of an n-byte OSC field once padded to a 4-byte boundary."""
    return (n + 3) & ~3


def _read_string(data, i):
    end = data.index(b"\0", i)
    return data[i:end].decode("utf-8", "replace"), i + _padded(end - i + 1)


def _read_blob(data, i):
    (n,) = struct.unpack_from(">i", data, i)
    i += 4
    return data[i:i + n], i + _padded(n)


def _decode_message(data, i, end):
    address, i = _read_string(data, i)
    args = []
    tags = ","
    if i < end:
        tags, i = _read_string(data, i)
        for tag in tags[1:]:
            if tag == "i":
                args.append(struct.unpack_from(">i", data, i)[0]); i += 4
            elif tag == "f":
                args.append(struct.unpack_from(">f", data, i)[0]); i += 4
            elif tag == "d":
                args.append(struct.unpack_from(">d", data, i)[0]); i += 8
            elif tag == "h":
                args.append(struct.unpack_from(">q", data, i)[0]); i += 8
            elif tag in "sS":
                value, i = _read_string(data, i); args.append(value)
            elif tag == "b":
                value, i = _read_blob(data, i); args.append(value)
            elif tag == "t":
                args.append(struct.unpack_from(">Q", data, i)[0]); i += 8
            elif tag == "c":
                args.append(chr(struct.unpack_from(">i", data, i)[0])); i += 4
            elif tag in "rm":
                args.append(struct.unpack_from(">I", data, i)[0]); i += 4
            elif tag == "T":
                args.append(True)
            elif tag == "F":
                args.append(False)
            elif tag == "N":
                args.append(None)
            elif tag == "I":
                args.append(float("inf"))
            else:
                raise ValueError("unsupported OSC type tag %r" % tag)
    return address, args, tags[1:]


def decode(data, i=0, end=None):
    """Yields (address, args, types) for a message, or for each message in a bundle."""
    if end is None:
        end = len(data)
    if data[i:i + 8] == b"#bundle\0":
        i += 16  # the marker plus the 8-byte time tag
        while i + 4 <= end:
            (size,) = struct.unpack_from(">i", data, i)
            i += 4
            if size < 0 or i + size > end:
                return
            yield from decode(data, i, i + size)
            i += size
    else:
        yield _decode_message(data, i, end)


# ----------------------------------------------------------------- display

BODY_FIELDS = ["index", "x", "y", "z", "right", "up", "front",
               "distance", "azimuth", "elevation", "gain", "freq",
               "phase", "doppler"]


def display_name(address):
    """Readable fallback if /ss/bodies has not been seen yet: /ss/body/sun -> Sun."""
    return address.rsplit("/", 1)[-1].replace("-", " ").title()


def enable_ansi():
    """Windows consoles need virtual terminal processing turned on explicitly."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        pass


class Watch:
    """Keeps the latest value of every field and redraws a table a few times a second."""

    def __init__(self):
        self.names = {}          # address -> display name
        self.bodies = {}         # address -> dict of field values
        self.order = []          # addresses, in the order announced
        self.listener = None
        self.time = None
        self.packets = 0
        self.rate = 0.0
        self._window_start = time.monotonic()
        self._window_count = 0
        self._last_draw = 0.0

    def feed(self, address, args):
        if address == "/ss/bodies":
            self.order = []
            for n in range(args[0]):
                _, name, addr, freq, note = args[1 + n * 5: 6 + n * 5]
                self.names[addr] = "%s (%s)" % (name, note)
                self.order.append(addr)
        elif address == "/ss/listener":
            self.listener = args
        elif address == "/ss/time":
            self.time = args
        elif address.startswith("/ss/body/"):
            self.bodies[address] = dict(zip(BODY_FIELDS, args))
            if address not in self.order:
                self.order.append(address)

    def tick(self):
        self.packets += 1
        self._window_count += 1
        now = time.monotonic()
        if now - self._window_start >= 1.0:
            self.rate = self._window_count / (now - self._window_start)
            self._window_start = now
            self._window_count = 0
        if now - self._last_draw >= 0.1:
            self._last_draw = now
            self.draw()

    def draw(self):
        out = ["\033[H\033[J"]
        out.append("\033[1mSolar System OSC monitor\033[0m   "
                   "%d packets   %.1f pkt/s\n" % (self.packets, self.rate))

        if self.listener:
            out.append("listening from \033[36m%s\033[0m  "
                       "at (%.1f, %.1f, %.1f)  heading (%.2f, %.2f, %.2f)\n"
                       % (self.listener[1], *self.listener[2:5], *self.listener[5:8]))
        if self.time:
            sim, j2000, rate, paused = self.time
            out.append("t+%.2f d   J2000%+.2f d   %.2f d/s%s\n"
                       % (sim, j2000, rate, "   PAUSED" if paused else ""))

        out.append("\n  %-20s %8s %7s %8s %7s  %s\n"
                   % ("body", "az deg", "el deg", "dist", "gain", "level"))
        for address in self.order:
            b = self.bodies.get(address)
            if not b:
                continue
            bar = "#" * int(round(b["gain"] * 28))
            out.append("  %-20s %8.1f %7.1f %8.2f %7.3f  %s\n"
                       % (self.names.get(address) or display_name(address), b["azimuth"],
                          b["elevation"], b["distance"], b["gain"], bar))
        out.append("\nCtrl-C to stop.\n")
        sys.stdout.write("".join(out))
        sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser(description="Receive and display the demo's OSC stream.")
    ap.add_argument("--port", type=int, default=57120, help="UDP port to listen on")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind to")
    ap.add_argument("--raw", action="store_true", help="print every message instead of a table")
    args = ap.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    print("listening for OSC on udp %s:%d" % (args.host, args.port), flush=True)

    if args.raw:
        # flush=True so piping into a file or another tool stays live.
        while True:
            data, source = sock.recvfrom(65535)
            try:
                for address, values, types in decode(data):
                    print("%s  %s %s" % (source[0], address,
                                         " ".join(_fmt(v, t) for v, t in zip(values, types))),
                          flush=True)
            except Exception as exc:
                print("  malformed packet from %s: %s" % (source[0], exc), flush=True)
        return

    enable_ansi()
    watch = Watch()
    while True:
        data, _ = sock.recvfrom(65535)
        try:
            for address, values, _types in decode(data):
                watch.feed(address, values)
        except Exception:
            pass
        watch.tick()


def _fmt(value, tag):
    """Formats one argument the way its OSC type tag implies."""
    if tag in "fd":
        return "%.3f" % value
    if tag in "sS":
        return '"%s"' % value
    if tag == "b":
        return "<blob %d>" % len(value)
    return str(value)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped")
