package com.ebremer.solarsystem;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;

/**
 * Tells the page where to send its OSC.
 *
 * <pre>
 *   GET /api/config  ->  {"wsUrl":"ws://localhost:8888/osc","httpPort":8080,"bindHost":"127.0.0.1"}
 * </pre>
 *
 * {@code wsUrl} is null when no {@code --ws-url} was given, which the page reads as "use
 * whatever the user last entered in the OSC panel". This endpoint is read-only: there is
 * nothing on this server for a client to reconfigure, since it runs no relay.
 */
public class ConfigServlet extends HttpServlet {

    private final transient Config config;

    public ConfigServlet(Config config) {
        this.config = config;
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setStatus(HttpServletResponse.SC_OK);
        resp.setContentType("application/json;charset=utf-8");
        resp.setHeader("Cache-Control", "no-store");
        resp.getWriter().write("{"
                + "\"wsUrl\":" + quoteOrNull(config.wsUrl)
                + ",\"httpPort\":" + config.httpPort
                + ",\"bindHost\":\"" + jsonEscape(config.bindHost) + "\""
                + "}");
    }

    private static String quoteOrNull(String value) {
        return value == null ? "null" : "\"" + jsonEscape(value) + "\"";
    }

    static String jsonEscape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        return sb.toString();
    }
}
