package com.ebremer.solarsystem;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Serves the bridge configuration to the web app and lets it re-point the OSC destination.
 *
 * <pre>
 *   GET  /api/config   -> current settings plus relay counters
 *   POST /api/config   {"oscHost":"192.168.1.50","oscPort":9000}
 * </pre>
 *
 * The POST route is what the "OSC destination" box in the page uses, so you can aim the
 * demo at a different patch without restarting. It is refused with 403 when the server was
 * started with {@code --no-retarget}.
 */
public class ConfigServlet extends HttpServlet {

    private final transient Config config;
    private final transient OscUdpBridge bridge;

    public ConfigServlet(Config config, OscUdpBridge bridge) {
        this.config = config;
        this.bridge = bridge;
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        writeJson(resp, HttpServletResponse.SC_OK, describe(req));
    }

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        if (bridge == null) {
            writeJson(resp, HttpServletResponse.SC_FORBIDDEN,
                    "{\"error\":\"this server runs no relay (--no-websocket); "
                    + "set the WebSocket URL in the page instead\"}");
            return;
        }
        if (!config.allowRetarget) {
            writeJson(resp, HttpServletResponse.SC_FORBIDDEN,
                    "{\"error\":\"the OSC destination is pinned (--no-retarget)\"}");
            return;
        }
        String body = new String(req.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        Map<String, String> fields;
        try {
            fields = parseFlatJson(body);
        } catch (IllegalArgumentException e) {
            writeJson(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "{\"error\":\"malformed JSON: " + jsonEscape(e.getMessage()) + "\"}");
            return;
        }

        String host = fields.getOrDefault("oscHost", config.oscHost).trim();
        int port;
        try {
            port = Integer.parseInt(fields.getOrDefault("oscPort", String.valueOf(config.oscPort)).trim());
        } catch (NumberFormatException e) {
            writeJson(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "{\"error\":\"oscPort must be a number\"}");
            return;
        }

        String error = bridge.retarget(host, port);
        if (error != null) {
            writeJson(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "{\"error\":\"" + jsonEscape(error) + "\"}");
            return;
        }
        writeJson(resp, HttpServletResponse.SC_OK, describe(req));
    }

    /**
     * With no relay running, everything that describes it is reported as null rather than
     * as a plausible-looking zero, so the page can tell "nothing is being sent" apart from
     * "there is nothing here to send with".
     *
     * <p>{@code relayUrl} is this server's own endpoint and {@code wsUrl} is what the page
     * should default to. They differ when {@code --ws-url} points elsewhere, and comparing
     * the two is how the page knows whether it is talking to the local relay or somewhere
     * it cannot see past.
     */
    private String describe(HttpServletRequest req) {
        String relayUrl = bridge == null ? null
                : (req.isSecure() ? "wss" : "ws") + "://"
                  + req.getServerName() + ":" + req.getServerPort() + config.wsPath;
        String wsUrl = config.wsUrl != null ? config.wsUrl : relayUrl;

        if (bridge == null) {
            return "{\"websocket\":false"
                    + ",\"httpPort\":" + config.httpPort
                    + ",\"bindHost\":\"" + jsonEscape(config.bindHost) + "\""
                    + ",\"allowRetarget\":false"
                    + ",\"wsPath\":null,\"relayUrl\":null"
                    + ",\"wsUrl\":" + quoteOrNull(wsUrl)
                    + ",\"oscHost\":null,\"oscPort\":null"
                    + ",\"oscListenPort\":null,\"oscSourcePort\":null"
                    + ",\"stats\":null}";
        }
        return "{"
                + "\"websocket\":true"
                + ",\"oscHost\":\"" + jsonEscape(config.oscHost) + "\""
                + ",\"oscPort\":" + config.oscPort
                + ",\"oscListenPort\":" + config.oscListenPort
                + ",\"oscSourcePort\":" + bridge.localPort()
                + ",\"httpPort\":" + config.httpPort
                + ",\"bindHost\":\"" + jsonEscape(config.bindHost) + "\""
                + ",\"allowRetarget\":" + config.allowRetarget
                + ",\"wsPath\":\"" + jsonEscape(config.wsPath) + "\""
                + ",\"relayUrl\":" + quoteOrNull(relayUrl)
                + ",\"wsUrl\":" + quoteOrNull(wsUrl)
                + ",\"stats\":" + bridge.statsJson()
                + "}";
    }

    private static String quoteOrNull(String value) {
        return value == null ? "null" : "\"" + jsonEscape(value) + "\"";
    }

    private static void writeJson(HttpServletResponse resp, int status, String json) throws IOException {
        resp.setStatus(status);
        resp.setContentType("application/json;charset=utf-8");
        resp.setHeader("Cache-Control", "no-store");
        resp.getWriter().write(json);
    }

    // ---- minimal JSON helpers, enough for the flat objects this endpoint accepts ----

    static Map<String, String> parseFlatJson(String s) {
        Map<String, String> out = new LinkedHashMap<>();
        int n = s.length();
        int i = skipWs(s, 0);
        if (i >= n || s.charAt(i) != '{') throw new IllegalArgumentException("expected '{'");
        i = skipWs(s, i + 1);
        if (i < n && s.charAt(i) == '}') return out;
        while (i < n) {
            i = skipWs(s, i);
            if (i >= n || s.charAt(i) != '"') throw new IllegalArgumentException("expected a key");
            StringBuilder key = new StringBuilder();
            i = readString(s, i, key);
            i = skipWs(s, i);
            if (i >= n || s.charAt(i) != ':') throw new IllegalArgumentException("expected ':'");
            i = skipWs(s, i + 1);
            StringBuilder value = new StringBuilder();
            if (i < n && s.charAt(i) == '"') {
                i = readString(s, i, value);
            } else {
                int start = i;
                while (i < n && ",}".indexOf(s.charAt(i)) < 0) i++;
                value.append(s, start, i);
            }
            out.put(key.toString(), value.toString().trim());
            i = skipWs(s, i);
            if (i < n && s.charAt(i) == ',') { i++; continue; }
            if (i < n && s.charAt(i) == '}') break;
            throw new IllegalArgumentException("expected ',' or '}'");
        }
        return out;
    }

    private static int skipWs(String s, int i) {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        return i;
    }

    /** Reads the quoted string starting at {@code i} into {@code sink}, returning the index after it. */
    private static int readString(String s, int i, StringBuilder sink) {
        i++; // opening quote
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (c == '"') return i;
            if (c != '\\') { sink.append(c); continue; }
            if (i >= s.length()) break;
            char esc = s.charAt(i++);
            switch (esc) {
                case '"', '\\', '/' -> sink.append(esc);
                case 'b' -> sink.append('\b');
                case 'f' -> sink.append('\f');
                case 'n' -> sink.append('\n');
                case 'r' -> sink.append('\r');
                case 't' -> sink.append('\t');
                case 'u' -> {
                    if (i + 4 > s.length()) throw new IllegalArgumentException("truncated \\u escape");
                    sink.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                    i += 4;
                }
                default -> throw new IllegalArgumentException("bad escape \\" + esc);
            }
        }
        throw new IllegalArgumentException("unterminated string");
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
