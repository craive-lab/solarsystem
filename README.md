# Solar System — three.js, spatial audio, and OSC

A browser demo of the Sun and the eight planets on their real orbits, each singing a tone
of its own. Click any body and the audio listener moves onto it: you hear the rest of the
system from that vantage point, HRTF-panned, with the whole sound field slowly rotating
around you as the body you are standing on travels along its orbit.

Everything the listener hears — positions, bearings, elevations, gains — streams out as
OSC at up to 60 Hz, so a patch in SuperCollider, Max, Pd, TouchDesigner or anything else
can play along.

A small Jetty server hosts the page and bridges the OSC to UDP.

```
┌─────────────────────────────────────┐
│ browser                             │
│   three.js      orbits and picking  │
│   Web Audio     9 voices + HRTF     │
│   osc.js        encodes OSC packets │
└───────────────┬─────────────────────┘
                │ OSC packets as binary WebSocket frames
                │ ws://localhost:8080/osc
┌───────────────▼─────────────────────┐
│ Jetty 12                            │
│   DefaultServlet    the web app     │
│   ConfigServlet     /api/config     │
│   OscRelayEndpoint  WebSocket       │
│   OscUdpBridge      verbatim relay  │
└───────────────┬─────────────────────┘
                │ the same bytes, as UDP datagrams
                │ udp 127.0.0.1:57120  ← point this wherever you like
┌───────────────▼─────────────────────┐
│ your OSC receiver                   │
└─────────────────────────────────────┘
```

The WebSocket hop exists because a browser cannot open a UDP socket. osc.js encodes real
OSC packets in the page and the server copies the bytes onto the wire untouched — nothing
is re-encoded, so your receiver sees ordinary OSC.


## Quick start

Requires JDK 17 or newer and Maven.

```sh
mvn package
java -jar target/solarsystem.jar
```

Or build a standalone executable with no JVM required — see
[Native executable](#native-executable):

```sh
mvn -Pnative package
target/solarsystem.exe          # target/solarsystem on Linux and macOS
```

Either way, open <http://localhost:8080/>, press **Start with sound**, and click a planet.
Headphones matter here: HRTF panning needs two ears.

To watch the OSC without installing anything, in a second terminal:

```sh
python tools/osc-monitor.py        # or: node tools/osc-monitor.js
```

```
Solar System OSC monitor   1020 packets   30.0 pkt/s
listening from Earth  at (12.0, 0.0, 0.5)  heading (0.03, -0.00, -1.00)
t+55.18 d   J2000+9759.41 d   7.97 d/s

  body                   az deg  el deg     dist    gain  level
  Sun (A1)                -89.5     0.0    12.03   0.700  ####################
  Mercury (B5)           -113.2    -0.6    17.17   0.506  ##############
  Venus (E5)             -142.7    -7.8     4.36   1.000  ############################
  Earth (A4)                0.0     0.0     0.00   1.000  ############################
  Mars (D4)               -33.2     0.8    18.17   0.481  #############
  Jupiter (C3)            -55.3     0.5    39.21   0.232  ######
  Saturn (A3)              72.3    -3.4    29.66   0.303  ########
  Uranus (F3)              14.6    -0.2    57.32   0.160  ####
  Neptune (G2)             84.6    -1.6    65.77   0.140  ####
```

The Sun sitting at azimuth −89.5° is not a coincidence: standing on Earth facing your
direction of travel, the Sun is always about 90° off one shoulder.


## Controls

| | |
|---|---|
| click a body, or the list on the left | move the listener onto it |
| `1`–`9` | jump to a body |
| drag / scroll | orbit and zoom; the camera keeps tracking the selected body |
| `space` | pause the simulation |
| **Rate** | 0.05 to 300 simulated days per second |
| **Orbit tilt** | 1×–8× exaggeration of orbital inclination |
| **Doppler** | pitch shift from radial velocity |
| **Face direction of travel** | off = the listener uses the camera's orientation instead |

The **orbit tilt** control is worth a moment. The real solar system is nearly flat — every
planet is within 7° of the ecliptic — so at 1× there is almost nothing to hear above or
below you. Wind it up and the elevation cues appear.


## The sounds

Nine voices, all synthesised in the browser from the recipes in
`webapp/js/bodies.js`. No audio files are downloaded.

| body | note | Hz | voice |
|---|---|---|---|
| Sun | A1 | 55.00 | beating sawtooth drone with a solar-wind noise bed |
| Mercury | B5 | 987.77 | hard square wave under an 11 Hz tremolo |
| Venus | E5 | 659.26 | two triangles a few cents apart, slow shimmer |
| Earth | A4 | 440.00 | pure sine with its fifth and octave, gentle vibrato |
| Mars | D4 | 293.66 | resonant sawtooth swept by a slow band-pass |
| Jupiter | C3 | 130.81 | wide detuned sawtooths over a sub sine |
| Saturn | A3 | 220.00 | FM bell at an inharmonic 2.76 ratio |
| Uranus | F3 | 174.61 | sines beating at 3 Hz under an icy noise wash |
| Neptune | G2 | 98.00 | deep oceanic swell, one breath every 25 seconds |

The pitches form a chain of fifths (B–E–A–D–G–C–F), which is why nine simultaneous drones
stay consonant. Bigger bodies got lower notes.

Each voice also swells once per orbit, peaking at perihelion, so Mercury pulses about
every 88 simulated days while Neptune takes 165 years to complete one breath.

The body you are standing on is crossfaded onto a quieter non-spatial path, because a
PannerNode sitting exactly on the listener produces nothing useful.

Distance attenuation is the Web Audio `inverse` model with `refDistance` 8 and
`rolloffFactor` 0.85, in scene units. The `gain` value in the OSC stream is the same
number, computed with the same formula, so your patch can mirror the mix exactly:

```
gain = 8 / (8 + 0.85 * (max(distance, 8) - 8))
```


## Pointing it at your OSC receiver

Three ways, all equivalent. The default destination is `127.0.0.1:57120`.

**1. At startup**

```sh
java -jar target/solarsystem.jar --osc-host 192.168.1.50 --osc-port 9000
```

**2. From the page** — the OSC panel on the right has a host and port box. Type and press
**Set**. This takes effect immediately, without restarting or reloading.

**3. Over HTTP**

```sh
curl -X POST http://localhost:8080/api/config \
     -H 'Content-Type: application/json' \
     -d '{"oscHost":"192.168.1.50","oscPort":9000}'
```

`GET /api/config` returns the current settings plus relay counters, which is a quick way
to confirm packets are actually leaving:

```json
{"oscHost":"127.0.0.1","oscPort":57120,"oscListenPort":57121,"oscSourcePort":57121,
 "httpPort":8080,"bindHost":"127.0.0.1","allowRetarget":true,"wsPath":"/osc",
 "wsUrl":"ws://127.0.0.1:8080/osc",
 "stats":{"packetsOut":1020,"bytesOut":987836,"packetsIn":0,"dropped":0,"clients":1,
          "sourcePort":57121}}
```

Common destination ports, if you are wondering what to aim at:

| port | application |
|---|---|
| 57120 | SuperCollider (`sclang`) — the default here |
| 57110 | SuperCollider (`scsynth`) |
| 9000 | TouchDesigner, QLab |
| 8000 | Pure Data, Processing `oscP5` |
| 7400 | Reaper, OSCulator |

Add `--verbose` to print a decoded one-line summary of every packet crossing the bridge.
It is the fastest way to tell "the browser is not sending" apart from "the receiver is not
listening".


### Moving the WebSocket endpoint

The browser reaches the relay at `ws://<host>:<http-port>/osc` by default. `--ws-path`
puts it somewhere else, which matters when the demo sits behind a reverse proxy that
routes by path, or alongside another service that already owns `/osc`:

```sh
java -jar target/solarsystem.jar --ws-path /studio/osc-in
```

Nothing needs changing in the page. It never hardcodes the path — it asks `/api/config`,
which reports both `wsPath` and a ready-made `wsUrl` built from the request, so the host,
port and scheme all come out right whether you reached the page over `localhost`, a LAN
address, or `https` through a proxy.

A leading slash is optional and a trailing one is ignored, so `osc`, `/osc` and `/osc/`
all mean the same endpoint. Nested paths like `/bridge/osc` are fine. `/` and
`/api/config` are refused, as is anything with a query string, a space, or `{}` — braces
would be read as a URI template variable by the WebSocket container.

Like the ports, this is fixed at startup: the endpoint is registered with the container
when the server boots, so there is no live equivalent of the OSC destination box.

### Using your own bridge instead

`--no-websocket` turns the relay off completely. No WebSocket endpoint is registered, no
UDP socket is opened, no relay threads start; Jetty does nothing but serve the
application. The page then gets its WebSocket URL from its own settings:

```sh
java -jar target/solarsystem.jar --no-websocket
```

The OSC panel's **WebSocket** box becomes the control that matters. Type the URL of your
bridge and press **Go**:

```
ws://127.0.0.1:9001/osc
```

It is remembered in `localStorage`, so a reload reconnects to the same place. The UDP
destination box and the relay counters disappear, because they describe the built-in
relay and there no longer is one.

To skip the typing, `--ws-url` supplies the default:

```sh
java -jar target/solarsystem.jar --no-websocket --ws-url ws://127.0.0.1:9001/osc
```

Now the page connects on load with nothing to configure, which is what you want for a
scripted launch or a machine you do not sit at. It is a *default*, not a lock: a URL
already saved in the browser still wins, and clearing the box reverts to whatever the
server offers. The URL is checked at startup, so a typo fails there rather than silently
in someone's browser.

`--ws-url` works with the relay left on too, though the server then says so, because its
own relay would sit unused:

```
Note: --ws-url sends the page to ws://127.0.0.1:9001/osc, so this server's own
      relay will sit unused. Add --no-websocket to switch it off.
```

That box is present even when the relay *is* running, where it defaults to this server's
own URL. Typing a different one overrides it; clearing it goes back to the server's.
So you can point at an external bridge without restarting, and `--no-websocket` is really
just the switch that stops offering a default.

`GET /api/config` reports `"websocket": false` and nulls out everything that describes the
relay, rather than returning plausible-looking zeros, and `POST` is refused with an
explanation. It also reports two URLs, which are only the same when the page is using this
server's own relay:

| field | meaning |
|---|---|
| `relayUrl` | this server's own endpoint, or `null` if it runs none |
| `wsUrl` | what the page should connect to by default |

A page whose socket is not on `relayUrl` shows `connected to an external bridge` and counts
only the bundles it has sent, because the relay's UDP counters would be describing someone
else's traffic — or nothing at all.

Your bridge needs to accept binary frames — osc.js sets `binaryType = "arraybuffer"` and
sends encoded OSC packets, exactly the bytes the built-in relay receives. Cross-origin is
fine: browsers do not apply a CORS preflight to WebSockets, though they do send `Origin`,
so a bridge that inspects it must allow the page's origin.

### Receiving from another machine

Point `--osc-host` at the other machine's address. Nothing else changes — the browser
still talks to the local server, which does the UDP send.

If you also want the *page* reachable from elsewhere, add `--bind 0.0.0.0`. Be aware of
what that means: the relay will then accept WebSocket connections from anyone who can
reach the port and emit UDP on their behalf. Add `--no-retarget` to at least pin the
destination. The server prints a warning when you do this.


### Talking back

Datagrams arriving on `--osc-listen-port` (default 57121) are forwarded to every connected
browser. The demo does not act on them yet, but the path is live and
`OscBridge` in `webapp/js/oscbridge.js` is an `EventTarget`, so wiring up a handler is a
few lines. Set `--osc-listen-port 0` to disable inbound entirely.

Replies should go to the **source port** shown in the banner, which is the same 57121 by
default.


## OSC address schema

Argument types are explicit — osc.js runs with `metadata: true` — so receivers that
dispatch on the type tag will behave. Only `i` (int32), `f` (float32) and `s` (string) are
used; there is nothing exotic to support.

Per tick, everything below the first three messages arrives as **one bundle** with time
tag 0 ("immediately"), so a receiver sees a coherent snapshot rather than eleven
independently timed messages.

### `/ss/bodies` — the layout

Sent on connect and repeated every 5 seconds, so a receiver started midway still learns
the table.

| arg | type | meaning |
|---|---|---|
| 0 | `i` | number of bodies (9) |

then five arguments per body:

| arg | type | meaning |
|---|---|---|
| | `i` | index, 0 = Sun … 8 = Neptune |
| | `s` | display name, e.g. `Saturn` |
| | `s` | that body's address, e.g. `/ss/body/saturn` |
| | `f` | voice frequency in Hz |
| | `s` | note name, e.g. `A3` |

### `/ss/select` — the listener moved

Sent once when you click a body.

| arg | type | meaning |
|---|---|---|
| 0 | `i` | index |
| 1 | `s` | name |

### `/ss/audio` — the audio engine started or stopped

| arg | type | meaning |
|---|---|---|
| 0 | `i` | 1 running, 0 stopped |

### `/ss/time` — transport

| arg | type | meaning |
|---|---|---|
| 0 | `f` | simulated days elapsed since the page loaded |
| 1 | `f` | days since J2000; add `2451545.0` for the Julian date |
| 2 | `f` | simulation rate, days per real second |
| 3 | `i` | 1 paused, 0 running |

Days since J2000 rather than the raw Julian date, because a float32 near 2.45 million only
resolves to a quarter of a day.

### `/ss/listener` — where you are standing

| arg | type | meaning |
|---|---|---|
| 0 | `i` | index of the body |
| 1 | `s` | name |
| 2–4 | `f` | world position x, y, z |
| 5–7 | `f` | forward unit vector |
| 8–10 | `f` | up unit vector |

### `/ss/body/<name>` — one per body, per tick

`<name>` is the lower-case body name: `/ss/body/sun`, `/ss/body/mercury`, … ,
`/ss/body/neptune`.

| arg | type | meaning |
|---|---|---|
| 0 | `i` | index |
| 1–3 | `f` | world position x, y, z |
| 4 | `f` | listener-relative **right** |
| 5 | `f` | listener-relative **up** |
| 6 | `f` | listener-relative **front** |
| 7 | `f` | distance from the listener, scene units |
| 8 | `f` | azimuth in degrees: 0 straight ahead, +90 to the right, ±180 behind |
| 9 | `f` | elevation in degrees, positive up |
| 10 | `f` | distance gain, 0–1, matching the Web Audio panner |
| 11 | `f` | voice frequency in Hz |
| 12 | `f` | orbital phase 0–1, where 0 is perihelion |
| 13 | `f` | Doppler shift in cents, 0 when the toggle is off |

The body you are listening from reports distance 0, azimuth 0, elevation 0 and gain 1.


## Coordinates and scale

Right-handed, Y up, matching three.js. The Sun is at the origin and the ecliptic is the
XZ plane.

Positions are compressed radially so that Mercury and Neptune are legible at the same
time:

```
R_scene = 12 * (r_AU ^ 0.55)          r_AU = (R_scene / 12) ^ (1 / 0.55)
```

Earth's orbit therefore lands at radius 12 and Neptune's at about 78, instead of a true
ratio of 30:1. Orbit lines are drawn through the same warp, so a planet always sits
exactly on its path. Body radii are compressed too, as `0.42 * (r_km / 6371) ^ 0.4`.

The listener's frame is:

* **front** — direction of travel along the orbit. For the Sun, which does not travel, its
  25.38-day rotation is used instead, so the planets drift slowly around your head.
* **up** — the orbital plane normal, `position × velocity`.
* **right** — `front × up`.

Orbital positions come from the JPL *Keplerian Elements for Approximate Positions of the
Major Planets*, propagated with a Newton solve of Kepler's equation. Good to a few
arc-minutes between 1800 and 2050. Eccentricity, inclination, ascending node and
perihelion are all included, so the orbits are genuinely elliptical and correctly oriented
— the simulation starts at the real current date.


## Receiver examples

### SuperCollider

`sclang` already listens on 57120, so nothing needs starting.

```supercollider
// msg[0] is the address; the arguments begin at msg[1].
OSCdef(\earth, { |msg|
    var azimuth = msg[9], elevation = msg[10], gain = msg[11], freq = msg[12];
    ("Earth  az % el % gain %".format(
        azimuth.round(0.1), elevation.round(0.1), gain.round(0.001))).postln;
}, '/ss/body/earth');

OSCdef(\moved, { |msg| ("now listening from " ++ msg[2]).postln }, '/ss/select');
```

### Pure Data

```
[udpreceive 8000]
|
[oscparse]
|
[list trim]
|
[route /ss/body/earth /ss/listener]
```

Start the server with `--osc-port 8000` to match.

### Max/MSP

```
[udpreceive 7400]
|
[route /ss/body/mars /ss/time]
```

Start with `--osc-port 7400`.

### python-osc

```python
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import BlockingOSCUDPServer

def on_body(address, *args):
    index, x, y, z, right, up, front, dist, az, el, gain, freq, phase, doppler = args
    print(f"{address:22} az {az:7.1f}  gain {gain:.3f}")

dispatcher = Dispatcher()
dispatcher.map("/ss/body/*", on_body)
BlockingOSCUDPServer(("127.0.0.1", 57120), dispatcher).serve_forever()
```

### TouchDesigner

Add an **OSC In CHOP** (or DAT) on port 9000 and start the server with
`--osc-port 9000`. The bundled messages arrive as separate channels per address.

### Bundled monitors

`tools/osc-monitor.py` and `tools/osc-monitor.js` need nothing installed — no `pip`, no
`npm`. Both are short and deliberately readable if you want a reference OSC 1.0 decoder.

```sh
python tools/osc-monitor.py --port 9000     # live table
python tools/osc-monitor.py --raw           # every message, one per line
node   tools/osc-monitor.js --raw
```


## Server options

```
--http-port <n>        HTTP port for the web app          (default 8080)
--bind <host>          interface to bind HTTP + UDP to     (default 127.0.0.1)
--osc-host <host>      where to send OSC over UDP          (default 127.0.0.1)
--osc-port <n>         UDP port to send OSC to             (default 57120)
--osc-listen-port <n>  UDP port for OSC coming back, 0=off (default 57121)
--ws-path <path>       WebSocket path osc.js connects to    (default /osc)
--ws-url <url>         tell the page to connect here instead of to this server
--no-websocket         serve the app only; run no OSC relay at all
--no-retarget          forbid changing the OSC target from the browser
--web-dir <dir>        serve the web app from a directory (development)
--verbose              print a decoded summary of every packet
--help
```

For editing the front end without rebuilding:

```sh
java -jar target/solarsystem.jar --web-dir src/main/resources/webapp
```


## Native executable

The `native` Maven profile compiles the whole thing ahead of time with GraalVM
`native-image`:

```sh
mvn -Pnative package
```

|  | `mvn package` | `mvn -Pnative package` |
|---|---|---|
| output | `target/solarsystem.jar` | `target/solarsystem.exe` |
| size | 5.2 MB | 38 MB |
| needs a JVM installed | yes | no |
| Jetty ready in | ~300 ms | ~25 ms |
| build takes | ~3 s | ~20 s |

The executable is genuinely standalone — the whole web app, three.js and osc.js included,
is embedded in it. Copy that one file anywhere and run it. `native-image` also drops a
`management_ext.dll` next to it; that is only needed if you enable JVM monitoring, which
this profile deliberately does not, so you can ignore it.

Everything works exactly as it does on the JVM: static hosting, `/api/config`, the
WebSocket relay, inbound UDP, and `--verbose` packet decoding. The options are identical,
and `--help` adjusts its usage line to match how you launched it.

### How the reflection is handled

Closed-world compilation cannot see reflection, and Jetty uses plenty of it — service
providers are found with `ServiceLoader`, and message decoders are resolved by type. Two
metadata files cover it, both under
`src/main/resources/META-INF/native-image/`, where `native-image` picks them up
automatically:

* **`com.ebremer/solarsystem/`** — produced by the tracing agent against a real run.
* **`com.ebremer/solarsystem-webapp/`** — hand-written, and kept in a separate directory
  so regenerating the trace cannot clobber it. It holds a single `webapp/**` glob. The
  agent can only record files it actually saw fetched, so relying on it would silently
  drop any asset added later.

To regenerate the traced half after changing the Java code, run the jar under the agent
and exercise it — load the page, click a body, let OSC flow for a while:

```sh
java -agentlib:native-image-agent=config-output-dir=src/main/resources/META-INF/native-image/com.ebremer/solarsystem,config-write-period-secs=4 \
     -jar target/solarsystem.jar --verbose
```

`config-write-period-secs` matters: the agent normally writes on clean JVM exit, and on
Windows there is no easy way to deliver that to a background process. Delete the `.lock`
file it leaves behind, and drop the `webapp/...` resource entries it records, since the
glob already covers them.

Note that `OscRelayEndpoint` needs no reflection metadata at all. It is a programmatic
`jakarta.websocket.Endpoint` registered through `ServerEndpointConfig` with a configurator
that hands the container a ready-made instance, so nothing about it is constructed or
dispatched reflectively. That was forced by `--ws-path` — `@ServerEndpoint` takes a
compile-time constant and so cannot carry a runtime path — but it made the native image
simpler as a side effect.

### If the native build fails

* **`native-image` not found** — use a GraalVM JDK. `JAVA_HOME` must point at it; check
  with `native-image --version`.
* **`cl.exe` / linker errors on Windows** — install Visual Studio with the "Desktop
  development with C++" workload. `native-image` finds it automatically; you do not need
  an x64 Native Tools prompt.
* **`ClassNotFoundException` or a missing resource at runtime, but not on the JVM** —
  something reflective was missed. Re-run the agent and exercise the path that broke.

### Why not Jetty's DefaultServlet

The JVM build used to serve static files with Jetty's `DefaultServlet`, which resolves
content through `ResourceFactory`. That only understands the `file:`, `jar:` and `jrt:`
URL schemes, and a native image has no jar at all — its embedded resources come back as
`resource:` URLs, so the packaged web app would have been unreachable. `StaticServlet`
reads the classpath directly instead, which behaves identically in both builds, and as a
bonus needs no reflection metadata because servlet *instances* are registered rather than
classes.


## Layout

```
pom.xml                    the `native` profile lives here
src/main/java/com/ebremer/solarsystem/
  SolarSystemServer.java   Jetty bootstrap, static hosting, banner
  Config.java              command line options
  StaticServlet.java       serves the web app from the classpath
  ConfigServlet.java       GET/POST /api/config
  OscRelayEndpoint.java    WebSocket endpoint, path from --ws-path
  OscUdpBridge.java        WebSocket ⇄ UDP, both directions
  OscPeek.java             OSC decoder for --verbose logging
src/main/resources/META-INF/native-image/com.ebremer/
  solarsystem/             reachability metadata, agent generated
  solarsystem-webapp/      reachability metadata, hand written
src/main/resources/webapp/
  index.html  css/style.css
  js/bodies.js      orbital elements, Kepler solver, synth recipes
  js/audio.js       Web Audio graph, panners, listener, distance model
  js/oscbridge.js   osc.js transport and the bundle builder
  js/radar.js       the azimuth dial
  js/ui.js          panels and controls
  js/main.js        scene, loop, picking, wiring
  vendor/           three.js 0.180.0, OrbitControls, osc.js 2.4.5
tools/
  osc-monitor.py  osc-monitor.js
```

The vendored libraries are committed on purpose: the demo runs with no network access and
no build step for the front end. `three.module.js` imports `three.core.js`, so both files
must stay side by side.


## Troubleshooting

**No sound.** Browsers will not start an AudioContext without a gesture — press **Start
with sound**. If the page was opened silently, the **Start audio** button in the Audio
panel does the same thing.

**The OSC dot is red or amber.** Amber means it is reconnecting, which is normal if the
server restarted; it backs off up to 10 seconds. Red with `osc.js failed to load` means
`vendor/osc-browser.min.js` did not load.

**The dot is green but nothing arrives.** The green dot only means the browser reached the
bridge. Check `packetsOut` in `GET /api/config` — if it is climbing, the packets are
leaving and the problem is downstream: wrong port, a firewall, or a receiver bound to
`127.0.0.1` when the packets come from elsewhere. `--verbose` will show you exactly what
is being sent where.

**Address already in use** for UDP 57121 usually means something else (often
SuperCollider) already holds it. The server falls back to an ephemeral source port and
tells you so; inbound OSC is then disabled. `--osc-listen-port 0` makes that explicit.

**Everything is dark.** WebGL may be unavailable or blocked; check the browser console.

**Writing a Node OSC client?** Node 22+ ships a global `WebSocket` from undici that
ignores osc.js's `binaryType = "nodebuffer"` and delivers `Blob`s instead. Pass osc.js a
socket from the `ws` package explicitly: `new osc.WebSocketPort({ socket: new WebSocket(url) })`.
Browsers get `"arraybuffer"` and are unaffected.


## Licences

three.js (MIT) and osc.js (MIT / GPL-3.0) are vendored under `webapp/vendor/` with their
licence files. Orbital elements are from JPL/E. M. Standish, *Keplerian Elements for
Approximate Positions of the Major Planets*.
