package com.ebremer.solarsystem;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * Runtime configuration for the solar system server.
 *
 * <p>Everything can be set on the command line; the OSC destination can additionally be
 * re-pointed at runtime through {@code POST /api/config} (see {@link ConfigServlet}) unless
 * {@code --no-retarget} was given.
 */
public final class Config {

    /** Port the Jetty HTTP/WebSocket server listens on. */
    public int httpPort = 8080;

    /** Interface the HTTP server and the UDP socket bind to. Loopback by default. */
    public String bindHost = "127.0.0.1";

    /** Host that OSC packets from the browser are forwarded to over UDP. */
    public volatile String oscHost = "127.0.0.1";

    /** UDP port that OSC packets from the browser are forwarded to. */
    public volatile int oscPort = 57120;

    /** UDP port to listen on for OSC coming back the other way. 0 disables inbound. */
    public int oscListenPort = 57121;

    /** Whether {@code POST /api/config} may change {@link #oscHost}/{@link #oscPort}. */
    public boolean allowRetarget = true;

    /**
     * Whether this server runs the OSC relay at all. Turn it off to leave Jetty doing
     * nothing but serving the application: no WebSocket endpoint is registered and no UDP
     * socket is opened, and the page is told to get its WebSocket URL from its own
     * settings instead, so osc.js can talk to a bridge you run yourself.
     */
    public boolean websocket = true;

    /**
     * WebSocket URL handed to the page as its default, overriding the one derived from
     * the request. Null means "derive it", which is what a server running its own relay
     * normally wants. Set it to point the page at a bridge elsewhere, typically alongside
     * {@link #websocket} being off.
     */
    public String wsUrl = null;

    /** Decode and print every packet that crosses the bridge. */
    public boolean verbose = false;

    /** Optional directory to serve the web app from instead of the packaged classpath copy. */
    public String webDir = null;

    /**
     * WebSocket path that osc.js connects to. Fixed once the server starts, because the
     * endpoint is registered with the container at that point. The page never hardcodes
     * it: it reads the full URL back from {@code /api/config}.
     */
    public String wsPath = "/osc";

    /**
     * How this process was launched, so the usage text names the right command. The
     * property is set by the GraalVM runtime and absent on a normal JVM.
     */
    public static final boolean NATIVE_IMAGE =
            System.getProperty("org.graalvm.nativeimage.imagecode") != null;

    private static final String LAUNCHER =
            NATIVE_IMAGE ? "solarsystem" : "java -jar solarsystem.jar";

    private static final String USAGE = """
        Usage: %s [options]

          --http-port <n>        HTTP port for the web app          (default 8080)
          --bind <host>          Interface to bind HTTP + UDP to     (default 127.0.0.1)
          --osc-host <host>      Where to send OSC over UDP          (default 127.0.0.1)
          --osc-port <n>         UDP port to send OSC to             (default 57120)
          --osc-listen-port <n>  UDP port for OSC coming back, 0=off (default 57121)
          --ws-path <path>       WebSocket path osc.js connects to    (default /osc)
          --ws-url <url>         Tell the page to connect here instead of to this server
          --no-websocket         Serve the app only; run no OSC relay at all
          --no-retarget          Forbid changing the OSC target from the browser
          --web-dir <dir>        Serve the web app from a directory (development)
          --verbose              Print a decoded summary of every packet
          --help                 Show this message

        Common OSC destination ports:
          57120  SuperCollider (sclang)      9000  TouchDesigner / QLab
          57110  SuperCollider (scsynth)     8000  Pure Data / Processing oscP5
          7400   Reaper / OSCulator          4560  Max/MSP udpreceive convention
        """.formatted(LAUNCHER);

    /**
     * Outcome of parsing the command line. A null {@link #config()} means the program
     * should stop with {@link #exitCode()}, which distinguishes "the user asked for help"
     * from "the user got it wrong".
     */
    public record Result(Config config, int exitCode) {
        static Result ok(Config config) { return new Result(config, 0); }
        static Result help()            { return new Result(null, 0); }
        static Result error()           { return new Result(null, 1); }
    }

    /** Parses command line arguments. */
    public static Result parse(String[] args) {
        Config c = new Config();
        boolean bindSeen = false;
        boolean relayOptionsSeen = false;
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            try {
                switch (a) {
                    case "--http-port"       -> c.httpPort = port(args[++i], a);
                    case "--bind"            -> { c.bindHost = args[++i]; bindSeen = true; }
                    case "--osc-host"        -> { c.oscHost = args[++i]; relayOptionsSeen = true; }
                    case "--osc-port"        -> { c.oscPort = port(args[++i], a); relayOptionsSeen = true; }
                    case "--osc-listen-port" -> { c.oscListenPort = portOrZero(args[++i], a); relayOptionsSeen = true; }
                    case "--ws-path"         -> { c.wsPath = websocketPath(args[++i], a); relayOptionsSeen = true; }
                    case "--ws-url"          -> c.wsUrl = websocketUrl(args[++i], a);
                    case "--no-websocket"    -> c.websocket = false;
                    case "--no-retarget"     -> { c.allowRetarget = false; relayOptionsSeen = true; }
                    case "--web-dir"         -> c.webDir = args[++i];
                    case "--verbose", "-v"   -> c.verbose = true;
                    case "--help", "-h"      -> { System.out.print(USAGE); return Result.help(); }
                    default -> {
                        System.err.println("Unknown option: " + a + "\n");
                        System.err.print(USAGE);
                        return Result.error();
                    }
                }
            } catch (ArrayIndexOutOfBoundsException e) {
                System.err.println(a + " requires a value\n");
                System.err.print(USAGE);
                return Result.error();
            } catch (IllegalArgumentException e) {
                System.err.println(e.getMessage() + "\n");
                System.err.print(USAGE);
                return Result.error();
            }
        }
        if (c.wsUrl != null && c.websocket) {
            System.out.println("""
                Note: --ws-url sends the page to %s, so this server's own
                      relay will sit unused. Add --no-websocket to switch it off.
                """.formatted(c.wsUrl));
        }
        if (!c.websocket && relayOptionsSeen) {
            System.out.println("""
                Note: --no-websocket turns the relay off entirely, so the OSC and WebSocket
                      options given alongside it have nothing to act on.
                """);
        }
        if (bindSeen && !c.isLoopbackBind() && c.websocket) {
            System.out.println("""
                WARNING: binding to a non-loopback interface exposes this UDP relay to your
                         network. Anyone who can reach it can make it emit UDP packets. Add
                         --no-retarget to at least pin the destination.
                """);
        }
        return Result.ok(c);
    }

    /** Checks an absolute WebSocket URL, so a typo fails at startup rather than in a browser. */
    private static String websocketUrl(String s, String flag) {
        String url = s.trim();
        java.net.URI uri;
        try {
            uri = new java.net.URI(url);
        } catch (java.net.URISyntaxException e) {
            throw new IllegalArgumentException(flag + ": '" + s + "' is not a URL");
        }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equals("ws") || scheme.equals("wss"))) {
            throw new IllegalArgumentException(flag + ": '" + s + "' must start with ws:// or wss://");
        }
        if (uri.getHost() == null) {
            throw new IllegalArgumentException(flag + ": '" + s + "' has no host");
        }
        return url;
    }

    /**
     * Normalises and checks a WebSocket path. A leading slash is added if missing and a
     * trailing one is dropped, so {@code osc}, {@code /osc} and {@code /osc/} are all
     * accepted and mean the same endpoint.
     */
    private static String websocketPath(String s, String flag) {
        String path = s.trim();
        if (!path.startsWith("/")) path = "/" + path;
        while (path.length() > 1 && path.endsWith("/")) path = path.substring(0, path.length() - 1);

        if (path.equals("/")) {
            throw new IllegalArgumentException(flag + ": the path cannot be '/', that is the web app");
        }
        // Deliberately no '{}': the container would read those as URI template variables.
        if (!path.matches("/[A-Za-z0-9._~/-]+")) {
            throw new IllegalArgumentException(flag + ": '" + s
                    + "' must be a plain path such as /osc or /bridge/osc");
        }
        if (path.equals("/api/config") || path.startsWith("/api/config/")) {
            throw new IllegalArgumentException(flag + ": /api/config is the server's own endpoint");
        }
        return path;
    }

    private static int portOrZero(String s, String flag) {
        return "0".equals(s.trim()) ? 0 : port(s, flag);
    }

    private static int port(String s, String flag) {
        int v;
        try {
            v = Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(flag + ": '" + s + "' is not a number");
        }
        if (v < 1 || v > 65535) throw new IllegalArgumentException(flag + ": port out of range: " + v);
        return v;
    }

    public boolean isLoopbackBind() {
        try {
            return InetAddress.getByName(bindHost).isLoopbackAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    /** Address a browser on this machine should use. */
    public String browserUrl() {
        String h = bindHost;
        if ("0.0.0.0".equals(h) || "::".equals(h) || h.isEmpty()) h = "localhost";
        if (h.contains(":")) h = "[" + h + "]";
        return "http://" + h + ":" + httpPort + "/";
    }
}
