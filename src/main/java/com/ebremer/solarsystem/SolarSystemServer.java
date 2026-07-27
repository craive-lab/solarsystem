package com.ebremer.solarsystem;

import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import jakarta.websocket.server.ServerEndpointConfig;
import org.eclipse.jetty.ee10.websocket.jakarta.server.config.JakartaWebSocketServletContainerInitializer;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Hosts the three.js solar system and relays its OSC traffic to a UDP peer.
 *
 * <pre>
 *   browser  --(OSC over WebSocket, osc.js)-->  Jetty  --(OSC over UDP)-->  your patch
 * </pre>
 *
 * Run with {@code --help} for the full option list.
 */
public final class SolarSystemServer {

    public static void main(String[] args) throws Exception {
        Config.Result parsed = Config.parse(args);
        if (parsed.config() == null) {
            System.exit(parsed.exitCode());
            return;
        }
        Config config = parsed.config();

        // With --no-websocket there is no relay at all: no UDP socket, no endpoint, no
        // threads. Jetty is left doing nothing but serving the application.
        OscUdpBridge bridge = config.websocket ? new OscUdpBridge(config) : null;

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
                if (bridge != null) bridge.close();
                System.exit(2);
                return;
            }
        }
        StaticServlet statics = new StaticServlet(webDir);
        // Servlet instances are registered directly rather than by class, so nothing here
        // needs reflection and the native image works without extra configuration.
        context.addServlet(new ServletHolder("static", statics), "/");
        context.addServlet(new ServletHolder("config", new ConfigServlet(config, bridge)), "/api/config");

        if (bridge != null) {
            // One shared endpoint instance: it holds no per-connection state, and handing
            // the container a ready-made object means it never reflects to construct one.
            OscRelayEndpoint endpoint = new OscRelayEndpoint(bridge, config.wsPath);
            JakartaWebSocketServletContainerInitializer.configure(context,
                    (servletContext, wsContainer) -> {
                        wsContainer.setDefaultMaxBinaryMessageBufferSize(64 * 1024);
                        // Comfortably longer than the bridge's 20 second keepalive ping, so
                        // a page that stops sending (backgrounded tab, rate off) survives.
                        wsContainer.setDefaultMaxSessionIdleTimeout(90_000);
                        wsContainer.addEndpoint(ServerEndpointConfig.Builder
                                .create(OscRelayEndpoint.class, config.wsPath)
                                .configurator(new ServerEndpointConfig.Configurator() {
                                    @Override
                                    public <T> T getEndpointInstance(Class<T> endpointClass) {
                                        return endpointClass.cast(endpoint);
                                    }
                                })
                                .build());
                    });
        }

        server.setHandler(context);
        server.setStopAtShutdown(true);
        if (bridge != null) {
            Runtime.getRuntime().addShutdownHook(new Thread(bridge::close, "bridge-shutdown"));
        }

        server.start();
        printBanner(config, bridge, statics.describe());
        server.join();
    }

    private static void printBanner(Config config, OscUdpBridge bridge, String webRoot) {
        if (bridge == null) {
            // Continuation lines carry their own two-space indent: the text block below has
            // already been stripped of its by the time %s is substituted.
            String advice = config.wsUrl != null
                    ? "The page connects there on load. Change it from the OSC panel if you\n"
                      + "  need to; the page remembers what you set."
                    : "Set the WebSocket URL in the page's OSC panel to point osc.js at your\n"
                      + "  own bridge; the page remembers it.";
            System.out.printf("""

                      Solar System  .  three.js + spatial audio + OSC

                      Open            %s
                      OSC relay       disabled (--no-websocket)
                      Page connects   %s
                      Web root        %s

                      Jetty is serving the application and nothing else.
                      %s
                      See README.md for the address schema. Ctrl-C to stop.

                    """,
                    config.browserUrl(),
                    config.wsUrl != null ? config.wsUrl : "nothing yet (no --ws-url given)",
                    webRoot,
                    advice);
            return;
        }
        String inbound = config.oscListenPort > 0
                ? "udp/" + config.bindHost + ":" + config.oscListenPort + " -> browser"
                : "disabled";
        String howToChange = config.allowRetarget
                ? "Change it from the page's OSC panel, or POST /api/config."
                : "The destination is pinned; restart without --no-retarget to change it live.";
        System.out.printf("""

                  Solar System  .  three.js + spatial audio + OSC

                  Open            %s
                  OSC WebSocket   ws://%s:%d%s
                  Page connects   %s
                  OSC destination %s:%d  (udp, source port %d)
                  OSC inbound     %s
                  Retargeting     %s
                  Web root        %s

                  Point your OSC receiver at %s:%d.
                  %s
                  See README.md for the address schema. Ctrl-C to stop.

                """,
                config.browserUrl(),
                config.bindHost, config.httpPort, config.wsPath,
                config.wsUrl != null ? config.wsUrl + "  (--ws-url, relay unused)" : "this server's relay",
                config.oscHost, config.oscPort, bridge.localPort(),
                inbound,
                config.allowRetarget ? "allowed from the browser" : "disabled (--no-retarget)",
                webRoot,
                config.oscHost, config.oscPort, howToChange);
    }

    private SolarSystemServer() {}
}
