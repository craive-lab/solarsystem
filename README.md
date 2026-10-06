# Solar System — three.js, spatial audio, and OSC

A browser demo of the Sun and the eight planets on their real orbits, each singing a tone
of its own. Click any body and the audio listener moves onto it: you hear the rest of the
system from that vantage point, HRTF-panned, with the whole sound field slowly rotating
around you as the body you are standing on travels along its orbit.

Everything the listener hears — positions, bearings, elevations, gains — streams out as
OSC at up to 60 Hz, so a patch in SuperCollider, Max, Pd, TouchDesigner or anything else
can play along.

A small Jetty server hosts the page. That is all it does — it runs no OSC machinery of its
own. The page opens a WebSocket straight to a bridge you provide, named by `--ws-url`.

```
┌─────────────────────────────────────┐      ┌──────────────────────────┐
│ browser                             │      │ Jetty 12                 │
│   three.js      orbits and picking  │◄─────┤   StaticServlet  the app │
│   Web Audio     9 voices + HRTF     │ http │   ConfigServlet  --ws-url│
│   osc.js        encodes OSC packets │      └──────────────────────────┘
└───────────────┬─────────────────────┘        delivers the page, then
                │                              takes no further part
                │ OSC packets as binary WebSocket frames
                │ ws://localhost:8888/osc
┌───────────────▼─────────────────────┐
│ your bridge                         │
└───────────────┬─────────────────────┘
                │ OSC over UDP, or wherever you route it
┌───────────────▼─────────────────────┐
│ your OSC receiver                   │
└─────────────────────────────────────┘
```

The WebSocket hop exists because a browser cannot open a UDP socket. osc.js encodes real
OSC packets in the page, so a bridge that forwards the binary frames verbatim gives your
receiver ordinary OSC — see [What a bridge has to do](#what-a-bridge-has-to-do).


## Quick start

Ready-built binaries are committed in [`build/`](build/), so there is nothing to compile:

```sh
build/solarsystem.exe --ws-url ws://localhost:8888/osc             # Windows, no Java needed
java -jar build/solarsystem.jar --ws-url ws://localhost:8888/osc   # any OS with Java 21+
```

`run.cmd` and `run.sh` do the second. To rebuild either binary yourself, see
[Building](#building).

Either way, open <http://localhost:8080/>, press **Start audio** in the Audio panel, and
click a planet. Headphones matter here: HRTF panning needs two ears. For the CRAIVE Lab's wrap-around
band, open <http://localhost:8080/?mode=craive> instead — see
[The CRAIVE Lab](#the-craive-lab-modecraive).

`--ws-url` is optional. Without it the page starts with no destination and you type one
into the **WebSocket server** box in its OSC panel, which is remembered for next time. The
visualisation and the audio work either way; only the OSC needs somewhere to go.

Once your bridge is delivering UDP, watch the stream without installing anything:

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
| click a body, or the list on the left | move the listener onto it; in flight, land on it |
| `1`–`9` | jump to a body, or land on it |
| drag / scroll | orbit and zoom; the camera keeps tracking the selected body |
| <kbd>↑</kbd> <kbd>↓</kbd> | take off, then fly forward and back |
| <kbd>←</kbd> <kbd>→</kbd> | take off, then turn left and right |
| <kbd>Page Up</kbd> <kbd>Page Dn</kbd> | take off, then climb and dive |
| <kbd>Shift</kbd> | hold to fly four times faster |
| drag, in flight | look around: across turns the ship, up and down tilts the view |
| `space` | pause the simulation |
| **Rate** | 0.05 to 300 simulated days per second |
| **Orbit tilt** | 1×–8× exaggeration of orbital inclination |
| **Doppler** | pitch shift from radial velocity |
| **Face direction of travel** | off = the listener uses the camera's orientation instead |
| **CRAIVE Lab band**, or <kbd>C</kbd> | switch to the CRAIVE view, keeping the date, settings and sound; the same again comes back |

### Flying on the desktop

Any arrow key, or Page Up/Down, lifts the listener off the body it is standing on and onto
a ship of its own, flown with the same controls and the same unhurried speeds as the
[CRAIVE band](#flying) — both views use `webapp/js/flight.js`. The ship starts exactly
where the camera was, heading where it was looking, so nothing jumps; from then on the
camera is the cockpit. The ship flies level and the listener with it, so a tilted view
does not tilt what you hear. Every body is spatialised while you fly, the Sound field panel
reads **In flight**, and the hint line along the bottom lists the flight keys.

Click a body, on screen or in the list, or press `1`–`9`, to land: the view swings round
onto it and settles into the usual orbit camera.

While flying, `/ss/listener` reports index **−1** and the name `ship`, and `/ss/select`
goes out once with the same pair at take-off. See [OSC address schema](#osc-address-schema).

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


## The CRAIVE Lab: `?mode=craive`

RPI's CRAIVE Lab is a walk-in panoramic room — a continuous projection band around four
walls, eight WUXGA projectors warped and edge-blended by Pixelwarp. The CRAIVE view renders
the solar system for it as a spaceship whose walls are all windows: the room *is* the
vehicle, the audience walks around inside it, and the nine voices are heard from wherever
it has flown to. Fly past Jupiter and it goes by down one side of the room.

```sh
build/solarsystem.exe --ws-url ws://localhost:8888/osc
```

then open <http://localhost:8080/?mode=craive> fullscreen on the desktop that spans the
eight projectors, and let Pixelwarp do the warping and blending.

The desktop view and the CRAIVE view are the same page. `?mode=craive` picks the view at
load; without it you get the desktop view. Once the page is up, the **CRAIVE Lab band**
checkbox in the View panel, or the <kbd>C</kbd> key, switches between them. Only one view
runs per page load — they need differently configured WebGL contexts, and the band's
capture targets are too large to leave lying around — so the switch reloads the page, but
it carries the simulated date, pause, every panel setting and the sound across, and goes
straight past the band's launch card. Chrome resumes the sound by itself after the reload;
Firefox and Safari hold it until your first click or key press.

Arriving on the band by the switch leaves the panels up, since that is where you just
were. Open `?mode=craive` fresh and they start hidden for the show, behind the launch card;
<kbd>C</kbd> still switches back without them. Where you are does not carry over: the band starts the ship at its
usual spot below the ecliptic, and the desktop starts on Earth.

### Flying

| | |
|---|---|
| <kbd>↑</kbd> <kbd>↓</kbd> | forward and back along the heading |
| <kbd>←</kbd> <kbd>→</kbd> | rotate left and right |
| <kbd>Page Up</kbd> <kbd>Page Dn</kbd> | climb and dive |
| <kbd>Shift</kbd> | hold to fly four times faster |
| click | fly to a body, on the wall or in the panel |
| <kbd>H</kbd> | operator HUD on the front wall (in the canvas) |
| <kbd>L</kbd> | audience labels and orbits |
| <kbd>P</kbd> | operator panels — they land on the walls, so the show starts without them |
| <kbd>C</kbd> | switch to the desktop view |

Yaw only — the heading never pitches or rolls, because a roomful of people standing up
should not have the horizon tilt under them. Speeds are deliberately unhurried: 14 scene
units per second against an Earth orbit of radius 12 and a Neptune orbit of 78.

Clicking a body flies the room to it and then holds station, so it stays framed as it
carries on along its orbit until someone takes the controls again. The approach eases in
rather than cutting, because an instant jump is disorienting when the audience is standing
up inside the picture. It arrives just below the ecliptic for the same reason the ship
starts there.

Clicks on the band invert the projection — canvas pixel to azimuth and elevation to a
world bearing — and then pick the body closest to that bearing, rather than raycasting
against the geometry. That is partly the natural question to ask on a panorama, and partly
forced: three.js resolves a sprite hit by projecting it through `raycaster.camera`, and a
view assembled from six cube faces has no single camera to offer. Testing bearings also
gives every body the same generous target, which matters when someone is pointing at a
wall several metres away.

Both floating panels are the desktop view's, not copies of them. On the left, `BodyList`
gives each body's bearing, elevation, distance and level, and clicking a row flies there.
On the right, `Controls` gives the same Audio, View, Time and OSC panels as the desktop
view — the view switch, pause, rate, orbit tilt, date, volume, Doppler, labels, and the
WebSocket server box. Both are built by `webapp/js/ui.js` and mounted by each view, so the
two front ends cannot end up with different controls. The one difference is the "face
direction of travel" switch, which only the desktop view has: on the band the listener is
the ship and always faces where it points.

Everything in the DOM is projected onto the wall along with the band, so <kbd>H</kbd>
hides both panels and the HUD for a clean room.

The ship starts 30 units out and 6 *below* the ecliptic, facing the Sun, which therefore
opens centred on the front wall. Below rather than above on purpose: the band is not
symmetric, reaching 23.6° above the horizon but only 13.6° below, so looking *up* at the
disc gives it most of the room's pixels to spread into. From exactly within the plane the
system collapses to a line on the horizon; a little altitude opens it into a disc.

### The output contract

Every number comes from the lab's content-creator spec (J. Parkman Carter, RPI, 2015) and
is declared in the `BAND` constant at the top of `webapp/js/craive.js`:

| | |
|---|---|
| band (authoring) | 1200 × 11,636 px, 9.697:1 — physical pixels around the room |
| output (delivery) | 1200 × 15,360 px, 12.8:1 — 8 × 1920, what Pixelwarp ingests |
| front wall centre | band x = 6,317 |
| entrance gap | band x 11,165–11,636, projected black |
| vertical field | 37.13°, centred 5° above the horizon |

The 132% horizontal "fatten" the manual pipeline applies is inherent here rather than a
separate step: the shader spreads the 11,636-px band across all 15,360 output pixels, so
rendering *is* the stretch. Circles look fat on a desktop preview and round on the wall.

### How it is rendered

Twelve perspective cameras sit on the ship at the top quality rung (30° of azimuth
each, 37.13° of elevation, optical axis pitched 5° above the horizon). Each strip is
rendered in linear HDR (half-float) with 4× MSAA, then copied into a non-MSAA 15360×1200
atlas. A fragment shader remaps those rectilinear slices onto the band's cylindrical
mapping — azimuth linear in canvas x, elevation linear in canvas y — crossfades 16 px at
each seam, and applies ACES tone mapping plus sRGB once onto the canvas. The entrance
strip is scissored off and left black. Logarithmic depth keeps the near 0.05 / star-field
2200 range honest.

The canvas is always 15360×1200 (`devicePixelRatio` 1). If the GPU cannot hold 60 fps,
capture quality drops in place: MSAA 4× → 2× → 0, then 12 → 8 → 6 slices, then a 2048
cubemap of the four side faces. The HUD shows the active rung and the frame rate, and
appends `dropped` once it has stepped down. Adding `capture=cube` or `rung=0..5` to the
query string, as in `?mode=craive&rung=2`, locks a rung.

The mapping is the lab's Photoshop pipeline (crop, equirectangular conversion,
recomposition) as a sample:

```glsl
if (vUv.x >= uEntrance.x && vUv.x <= uEntrance.y) { black; return; }
float theta = (vUv.x - uFrontFrac) * 2.0 * PI + uYaw;
float phi   = uElevCenter + (vUv.y - 0.5) * uVFov;
vec3 dir = vec3(sin(theta) * cos(phi), sin(phi), -cos(theta) * cos(phi));
```

Two consequences worth knowing if you extend it. Nothing drawn in HTML can appear on the
band, because the capture photographs the three.js scene, not the DOM — the body labels
are in-scene quads for exactly this reason, and the HUD in the corner is for whoever is
driving, not for the wall. Beacons and names are yaw-only billboards that face the ship
(so every slice camera draws the same silhouette) and are sized in degrees of azimuth.
Stars stay unattenuated `gl_PointSize` pixels: square on the fattened canvas, round on
the wall.

The two views share `webapp/js/scenery.js`, which owns the scene and the simulation.
Both load the same 2K JPL/NASA maps (anisotropy 8), 128-segment spheres, Saturn ring with
alpha, Earth limb, linear sun light, 8K star map and mag≤6 HYG catalog, and yaw-only
billboards sized in degrees. They differ in how they photograph it: the desktop view is an
orbit camera; the CRAIVE view is the Pixelwarp band. Pass
`SolarSystemScene({ quality: 'cheap' })` to keep the old procedural stripes.

The maps and credits live in `webapp/textures/`.

### What goes out over OSC

The same schema, with one difference: the listener is not a body. `/ss/listener` reports
index **−1** and the name `CRAIVE`, and its position is the ship's. Every one of the nine
bodies stays spatialised — there is no "you are here" body to duck. The ship's own
velocity feeds the Doppler shift alongside the planets', so flying hard at Jupiter bends
its pitch up.

### Checking it on the wall

* The canvas is exactly 15,360 × 1,200 — `document.getElementById('band').width`.
* With the heading at 0° the Sun sits at band x ≈ 6,317, centred on the front wall.
* The span 11,165–11,636 (the right-hand end of the canvas) is black.
* Pressing <kbd>←</kbd> slides the scene to the *right*.
* Clicking a body on the wall starts an approach: its row highlights and its distance in
  the panel starts falling.
* Nothing important sits in a corner or the entrance.
* The operator HUD is a plaque on the front wall, under the sky — not a DOM overlay.
  <kbd>H</kbd> hides it, <kbd>L</kbd> hides labels, <kbd>P</kbd> shows the side panels.


## Pointing it at your bridge

There is one setting, and two places to put it.

**At startup**, which is what you want for a scripted launch or a machine you do not sit
at — the page connects on load with nothing to configure:

```sh
java -jar build/solarsystem.jar --ws-url ws://localhost:8888/osc
```

**In the page**, in the OSC panel's **WebSocket server** box. Type a URL, press **Go**.
It is remembered in `localStorage`, so a reload reconnects to the same place.

A URL entered in the page wins over `--ws-url`, so a browser can be sent somewhere else
without restarting the server. Clearing the box drops the override and falls back to
whatever the server suggests. The URL given to `--ws-url` is checked at startup, so a typo
fails there rather than silently in someone's browser.

`GET /api/config` is how the page learns the default, and is the whole of this server's
API:

```json
{"wsUrl":"ws://localhost:8888/osc","httpPort":8080,"bindHost":"127.0.0.1"}
```

`wsUrl` is `null` when no `--ws-url` was given. There is nothing to POST — this server
holds no OSC state to change.

A note on hostnames: `localhost` often resolves to both `::1` and `127.0.0.1`, with IPv6
tried first. If your bridge binds IPv4 only, prefer `ws://127.0.0.1:8888/osc` to avoid a
stall while the browser falls back.


### What a bridge has to do

Very little. It accepts a WebSocket connection and forwards the binary frames onward —
they are already complete, well-formed OSC packets encoded by osc.js in the page, so a
verbatim copy into a UDP datagram is all that a normal OSC receiver needs.

* **Binary frames.** osc.js sets `binaryType = "arraybuffer"` and never sends text.
* **Bundles.** Most frames are OSC bundles with time tag 0. A receiver that only handles
  single messages needs to unwrap them; forwarding verbatim leaves that to the far end.
* **Size.** About 1 KB per frame with nine bodies, up to 60 frames a second.
* **Origin.** Browsers do not apply a CORS preflight to WebSockets but do send an `Origin`
  header, so a bridge that inspects it must allow the page's origin. The page and the
  bridge being on different ports is the normal case.
* **Mixed content.** If you serve the page over `https`, the bridge must be `wss://`.

Roughly twenty lines of Node covers it:

```js
const { Server } = require('ws');
const dgram = require('dgram');
const udp = dgram.createSocket('udp4');

new Server({ port: 8888, path: '/osc' }).on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) udp.send(data, 57120, '127.0.0.1');
  });
});
```

Point `tools/osc-monitor.py` at 57120 and you will see the stream.

### Reaching it from another machine

`--bind 0.0.0.0` makes the page reachable from elsewhere on the network. That now exposes
only a static file server, since this process holds no OSC socket of its own.

The `--ws-url` you hand out must be resolvable *from the browser*, not from the server, so
`ws://127.0.0.1:8888/osc` will not work for a remote viewer — use the bridge machine's
actual address.


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

Sent once when you click a body, and once with index −1 and the name `ship` when you take
off from one on the desktop.

| arg | type | meaning |
|---|---|---|
| 0 | `i` | index, or −1 for the ship |
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
| 0 | `i` | index of the body, or −1 when the listener is a ship |
| 1 | `s` | name: the body's, `ship` while flying on the desktop, `CRAIVE` on the band |
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

A ship — flying on the desktop, or the room on the CRAIVE band — flies level, so its front
is its heading in the ecliptic plane and its up is +Y.

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

Have your bridge forward to UDP 8000 to match.

### Max/MSP

```
[udpreceive 7400]
|
[route /ss/body/mars /ss/time]
```

Have your bridge forward to UDP 7400.

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

Add an **OSC In CHOP** (or DAT) on port 9000 and have your bridge forward there. The
bundled messages arrive as separate channels per address.

### Bundled monitors

`tools/osc-monitor.py` and `tools/osc-monitor.js` need nothing installed — no `pip`, no
`npm`. Point one at whatever UDP port your bridge forwards to. Both are short and
deliberately readable if you want a reference OSC 1.0 decoder.

```sh
python tools/osc-monitor.py --port 9000     # live table
python tools/osc-monitor.py --raw           # every message, one per line
node   tools/osc-monitor.js --raw
```


## Server options

```
--ws-url <url>     OSC WebSocket server the page connects to,
                   e.g. ws://localhost:8888/osc
--http-port <n>    HTTP port for the web app          (default 8080)
--bind <host>      interface to bind to               (default 127.0.0.1)
--web-dir <dir>    serve the web app from a directory (development)
--help
```

For editing the front end without rebuilding:

```sh
java -jar build/solarsystem.jar --web-dir src/main/resources/webapp
```


## Building

`build/` holds the finished binaries and is committed, so nobody needs Maven, a JDK or
GraalVM just to run the app. Maven writes straight into it; `target/` is still its scratch
space and stays ignored.

| command | writes | needs |
|---|---|---|
| `mvn package` | `build/solarsystem.jar` | JDK 21+ and Maven |
| `mvn -Pnative package` | `build/solarsystem.jar` and `build/solarsystem.exe` | GraalVM, and on Windows MSVC — see [Native executable](#native-executable) |

The committed binaries do not rebuild themselves. After changing anything that ships —
the Java or the web app — rebuild with `mvn -Pnative clean package` and commit `build/`
along with the change, or the repository keeps handing out the old version. Keep the
`clean`: Maven never removes a deleted file from `target/classes`, so without it a page
you have deleted is still embedded in both binaries.

The native executable is per platform, and the committed one is Windows x64. On Linux or
macOS use the jar, or run the native build there to get `build/solarsystem`.


## Native executable

The `native` Maven profile compiles the whole thing ahead of time with GraalVM
`native-image`:

```sh
mvn -Pnative package
```

|  | `mvn package` | `mvn -Pnative package` |
|---|---|---|
| output | `build/solarsystem.jar` | `build/solarsystem.exe` |
| size | 15 MB | 34 MB |
| needs a JVM installed | yes | no |
| Jetty ready in | ~300 ms | ~25 ms |
| build takes | ~3 s | ~45 s |

The executable is genuinely standalone — the whole web app, three.js and osc.js included,
is embedded in it. Copy that one file anywhere and run it. `native-image` also drops a
`management_ext.dll` next to it; that is only needed if you enable JVM monitoring, which
this profile deliberately does not, so you can ignore it. `.gitignore` keeps it out of the
repository.

Everything works exactly as it does on the JVM: static hosting, caching, and
`/api/config`. The options are identical, and `--help` adjusts its usage line to match how
you launched it.

### How the reflection is handled

Closed-world compilation cannot see reflection, and Jetty finds its service providers with
`ServiceLoader`. Two metadata files cover it, both under
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
     -jar build/solarsystem.jar --ws-url ws://localhost:8888/osc
```

`config-write-period-secs` matters: the agent normally writes on clean JVM exit, and on
Windows there is no easy way to deliver that to a background process. Delete the `.lock`
file it leaves behind, and drop the `webapp/...` resource entries it records, since the
glob already covers them.

None of this project's own classes need reflection metadata: both servlets are registered
as instances rather than by class name, so the container never constructs one.

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
build/                     committed build output, see Building
  solarsystem.jar          runnable jar, any OS with Java 21+
  solarsystem.exe          Windows x64 native executable, no Java needed
src/main/java/com/ebremer/solarsystem/
  SolarSystemServer.java   Jetty bootstrap, static hosting, banner
  Config.java              command line options
  StaticServlet.java       serves the web app from the classpath
  ConfigServlet.java       GET /api/config, reports --ws-url
src/main/resources/META-INF/native-image/com.ebremer/
  solarsystem/             reachability metadata, agent generated
  solarsystem-webapp/      reachability metadata, hand written
src/main/resources/webapp/
  index.html        both views; ?mode=craive picks the CRAIVE Lab band
  css/style.css
  css/craive.css    the CRAIVE view only, scoped to html.craive
  js/bodies.js      orbital elements, Kepler solver, synth recipes
  js/scenery.js     the scene and the simulation, shared by both views
  js/audio.js       Web Audio graph, panners, listener, distance model
  js/oscbridge.js   osc.js transport and the bundle builder
  js/radar.js       the azimuth dial
  js/ui.js          panels and controls
  js/flight.js      keyboard flight, shared by both views
  js/main.js        desktop view: camera follow, picking, take-off and landing, wiring
  js/craive.js      band view: band capture, unwrap shader, pick and approach
  vendor/           three.js 0.180.0, OrbitControls, osc.js 2.4.5
tools/
  osc-monitor.py  osc-monitor.js
```

The vendored libraries are committed on purpose: the demo runs with no network access and
no build step for the front end. `three.module.js` imports `three.core.js`, so both files
must stay side by side.


## Troubleshooting

**No sound.** Browsers will not start an AudioContext without a gesture, so the desktop
view opens silent — press **Start audio** in the Audio panel. On the band, **Launch** does
it.

**The OSC dot is amber and stays there.** It is retrying, backing off to ten seconds.
Either the bridge is not running, or the URL is wrong. The status line under the dot shows
which URL it is attempting. Amber is also normal and self-correcting while a bridge
restarts.

**The dot never leaves grey and reads "set a WebSocket server above".** No URL is
configured: pass `--ws-url`, or type one into the box.

**The dot is green but nothing arrives at your receiver.** Green means the browser reached
your bridge, and that is as far as this page can see. The problem is beyond it — check
that the bridge is forwarding *binary* frames, and that the far end is bound where you
expect. `tools/osc-monitor.py --raw` on the bridge's UDP destination will tell you whether
packets are landing at all.

**Everything is dark.** WebGL may be unavailable or blocked; check the browser console.

**Writing a Node OSC client?** Node 22+ ships a global `WebSocket` from undici that
ignores osc.js's `binaryType = "nodebuffer"` and delivers `Blob`s instead. Pass osc.js a
socket from the `ws` package explicitly: `new osc.WebSocketPort({ socket: new WebSocket(url) })`.
Browsers get `"arraybuffer"` and are unaffected.


## Licences

This project is released under the MIT Licence — see [LICENSE](LICENSE).

three.js (MIT) and osc.js (MIT / GPL-3.0) are vendored under `webapp/vendor/` with their
licence files. Orbital elements are from JPL/E. M. Standish, *Keplerian Elements for
Approximate Positions of the Major Planets*.
