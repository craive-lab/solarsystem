package com.ebremer.solarsystem;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Serves the web application from the classpath, or from a directory when {@code --web-dir}
 * is given.
 *
 * <p>Jetty's own {@code DefaultServlet} would do this, but it resolves files through
 * {@code ResourceFactory}, which only understands the {@code file:}, {@code jar:} and
 * {@code jrt:} URL schemes. A GraalVM native image has no jar at all — its resources come
 * back as {@code resource:} URLs — so the packaged web app would be unreachable in the
 * native build. Reading the classpath directly works the same way in both.
 *
 * <p>Classpath content is immutable once built, so it is read once and cached in memory;
 * the whole web app is about 2 MB. A {@code --web-dir} is re-read on every request instead,
 * which is the point of that flag.
 */
public class StaticServlet extends HttpServlet {

    private static final String CLASSPATH_ROOT = "webapp";
    private static final String WELCOME = "index.html";

    /**
     * Extensionless routes. /craive is the RPI CRAIVE Lab's wrap-around band view, named
     * after the room rather than after a file so it can be typed at a projector wall.
     */
    private static final Map<String, String> ROUTES = Map.of(
            "/craive", "/craive.html");

    private static final Map<String, String> CONTENT_TYPES = Map.ofEntries(
            Map.entry("html", "text/html;charset=utf-8"),
            Map.entry("css", "text/css;charset=utf-8"),
            Map.entry("js", "text/javascript;charset=utf-8"),
            Map.entry("mjs", "text/javascript;charset=utf-8"),
            Map.entry("json", "application/json;charset=utf-8"),
            Map.entry("map", "application/json;charset=utf-8"),
            Map.entry("txt", "text/plain;charset=utf-8"),
            Map.entry("svg", "image/svg+xml"),
            Map.entry("png", "image/png"),
            Map.entry("jpg", "image/jpeg"),
            Map.entry("gif", "image/gif"),
            Map.entry("ico", "image/x-icon"),
            Map.entry("woff2", "font/woff2"),
            Map.entry("wasm", "application/wasm"));

    /** Null when serving from the classpath. */
    private final transient Path directory;
    private final transient Map<String, byte[]> cache = new ConcurrentHashMap<>();

    public StaticServlet(Path directory) {
        this.directory = directory;
    }

    /** Human-readable description of where content is coming from, for the banner. */
    public String describe() {
        return directory != null ? directory.toString() : "classpath:/" + CLASSPATH_ROOT + "/";
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String path = req.getServletPath();
        if (req.getPathInfo() != null) path += req.getPathInfo();
        path = ROUTES.getOrDefault(path, path);
        if (path.isEmpty() || path.endsWith("/")) path += WELCOME;

        if (!isSafe(path)) {
            resp.sendError(HttpServletResponse.SC_FORBIDDEN);
            return;
        }

        byte[] body = load(path);
        if (body == null) {
            resp.sendError(HttpServletResponse.SC_NOT_FOUND);
            return;
        }

        // Content is fixed for the life of the process, so length plus path is a sound tag.
        String etag = "\"" + Integer.toHexString(path.hashCode()) + "-" + Integer.toHexString(body.length) + "\"";
        resp.setHeader("ETag", etag);
        resp.setHeader("Cache-Control", path.startsWith("/vendor/") ? "max-age=86400" : "no-cache");
        if (etag.equals(req.getHeader("If-None-Match"))) {
            resp.setStatus(HttpServletResponse.SC_NOT_MODIFIED);
            return;
        }

        resp.setStatus(HttpServletResponse.SC_OK);
        resp.setContentType(contentType(path));
        resp.setContentLength(body.length);
        try (OutputStream out = resp.getOutputStream()) {
            out.write(body);
        }
    }

    /**
     * Rejects anything that could escape the web root. Jetty already canonicalises and
     * rejects traversal before a request reaches a servlet; this is the belt to that
     * braces, and it also guards the {@code --web-dir} path.
     */
    private static boolean isSafe(String path) {
        if (!path.startsWith("/") || path.indexOf('\0') >= 0 || path.indexOf('\\') >= 0) return false;
        for (String segment : path.split("/")) {
            if (segment.equals("..")) return false;
        }
        return true;
    }

    /** Returns the bytes for a path, or null if there is nothing there. */
    private byte[] load(String path) throws IOException {
        if (directory != null) {
            Path file = directory.resolve(path.substring(1)).normalize();
            if (!file.startsWith(directory) || !Files.isRegularFile(file)) return null;
            return Files.readAllBytes(file);
        }
        byte[] cached = cache.get(path);
        if (cached != null) return cached;
        try (InputStream in = StaticServlet.class.getClassLoader()
                .getResourceAsStream(CLASSPATH_ROOT + path)) {
            if (in == null) return null;
            byte[] bytes = in.readAllBytes();
            cache.put(path, bytes);
            return bytes;
        }
    }

    private static String contentType(String path) {
        int dot = path.lastIndexOf('.');
        int slash = path.lastIndexOf('/');
        if (dot < 0 || dot < slash) return "application/octet-stream";
        return CONTENT_TYPES.getOrDefault(path.substring(dot + 1).toLowerCase(), "application/octet-stream");
    }
}
