package com.ebremer.solarsystem;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Runtime configuration.
 *
 * <p>This server only delivers the application. The page encodes OSC with osc.js and
 * sends it over a WebSocket to a bridge you run yourself, so the one thing worth
 * configuring is where that bridge lives: {@code --ws-url}.
 */
public final class Config {

    /** Port the Jetty HTTP server listens on. */
    public int httpPort = 8080;

    /** Interface the HTTP server binds to. Loopback by default. */
    public String bindHost = "127.0.0.1";

    /**
     * OSC WebSocket server the page connects to. Null leaves it unset, in which case the
     * page falls back to whatever was last entered in its own OSC panel.
     */
    public String wsUrl = null;

    /** Optional directory to serve the web app from instead of the packaged copy. */
    public String webDir = null;

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

          --ws-url <url>     OSC WebSocket server the page connects to,
                             e.g. ws://localhost:8888/osc
          --http-port <n>    HTTP port for the web app          (default 8080)
          --bind <host>      Interface to bind to               (default 127.0.0.1)
          --web-dir <dir>    Serve the web app from a directory (development)
          --help             Show this message

        This server delivers the application and nothing else. OSC leaves the browser
        over a WebSocket to the bridge named by --ws-url, which decides where the
        packets go next. The URL can also be set, and is remembered, in the page's
        own OSC panel.
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
        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            try {
                switch (a) {
                    case "--ws-url"     -> c.wsUrl = websocketUrl(args[++i], a);
                    case "--http-port"  -> c.httpPort = port(args[++i], a);
                    case "--bind"       -> c.bindHost = args[++i];
                    case "--web-dir"    -> c.webDir = args[++i];
                    case "--help", "-h" -> { System.out.print(USAGE); return Result.help(); }
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
        return Result.ok(c);
    }

    /** Checks an absolute WebSocket URL, so a typo fails here rather than in a browser. */
    private static String websocketUrl(String s, String flag) {
        String url = s.trim();
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
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

    /** Address a browser on this machine should use. */
    public String browserUrl() {
        String h = bindHost;
        if ("0.0.0.0".equals(h) || "::".equals(h) || h.isEmpty()) h = "localhost";
        if (h.contains(":")) h = "[" + h + "]";
        return "http://" + h + ":" + httpPort + "/";
    }
}
