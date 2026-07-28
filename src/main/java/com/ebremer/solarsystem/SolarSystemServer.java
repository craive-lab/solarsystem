package com.ebremer.solarsystem;

import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Serves the three.js solar system.
 *
 * <pre>
 *   Jetty  ──http──►  browser  ──OSC over WebSocket──►  your bridge  ──►  your receiver
 * </pre>
 *
 * That is the whole of this server's involvement: it hands over the application and gets
 * out of the way. The page encodes OSC with osc.js and opens its own WebSocket to the
 * bridge named by {@code --ws-url}, which is the only thing normally worth configuring.
 *
 * <p>Run with {@code --help} for the full option list.
 */
public final class SolarSystemServer {

    public static void main(String[] args) throws Exception {
        Config.Result parsed = Config.parse(args);
        if (parsed.config() == null) {
            System.exit(parsed.exitCode());
            return;
        }
        Config config = parsed.config();

        Server server = new Server();
        ServerConnector connector = new ServerConnector(server);
        connector.setHost(config.bindHost);
        connector.setPort(config.httpPort);
        server.addConnector(connector);

        ServletContextHandler context = new ServletContextHandler();
        context.setContextPath("/");

        Path webDir = null;
        if (config.webDir != null) {
            webDir = Path.of(config.webDir).toAbsolutePath().normalize();
            if (!Files.isDirectory(webDir)) {
                System.err.println("--web-dir is not a directory: " + webDir);
                System.exit(2);
                return;
            }
        }
        StaticServlet statics = new StaticServlet(webDir);
        // Servlet instances are registered directly rather than by class, so nothing here
        // needs reflection and the native image works without extra configuration.
        context.addServlet(new ServletHolder("static", statics), "/");
        context.addServlet(new ServletHolder("config", new ConfigServlet(config)), "/api/config");

        server.setHandler(context);
        server.setStopAtShutdown(true);

        server.start();
        printBanner(config, statics.describe());
        server.join();
    }

    private static void printBanner(Config config, String webRoot) {
        String advice = config.wsUrl != null
                ? "The page connects there on load. Change it from the OSC panel if you\n"
                  + "  need to; the page remembers what you set."
                : "No --ws-url was given, so the page will use whatever was last entered\n"
                  + "  in its OSC panel, or wait until you enter one.";
        System.out.printf("""

                  Solar System  .  three.js + spatial audio + OSC

                  Open            %s
                  OSC WebSocket   %s
                  Web root        %s

                  This server only delivers the application.
                  %s
                  See README.md for the OSC address schema. Ctrl-C to stop.

                """,
                config.browserUrl(),
                config.wsUrl != null ? config.wsUrl : "not set",
                webRoot,
                advice);
    }

    private SolarSystemServer() {}
}
