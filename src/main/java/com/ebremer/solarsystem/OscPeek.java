package com.ebremer.solarsystem;

import java.nio.BufferUnderflowException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * A read-only OSC 1.0 decoder used purely to render packets as text for {@code --verbose}
 * console output. The bridge itself forwards bytes untouched, so nothing here is on the
 * critical path and a malformed packet only spoils its own log line.
 */
final class OscPeek {

    private OscPeek() {}

    /** Renders an OSC packet as a single-line summary. Never throws. */
    static String describe(ByteBuffer packet) {
        StringBuilder sb = new StringBuilder();
        try {
            ByteBuffer b = packet.duplicate().order(ByteOrder.BIG_ENDIAN);
            decode(b, sb, 0);
        } catch (BufferUnderflowException | IllegalArgumentException e) {
            sb.append(" <malformed: ").append(e.getClass().getSimpleName()).append('>');
        }
        return sb.toString().trim();
    }

    private static void decode(ByteBuffer b, StringBuilder sb, int depth) {
        if (depth > 8) { sb.append("<nesting too deep>"); return; }
        int start = b.position();
        String head = readString(b);
        if ("#bundle".equals(head)) {
            b.getLong(); // NTP time tag, not shown
            sb.append("#bundle{");
            boolean first = true;
            while (b.remaining() >= 4) {
                int size = b.getInt();
                if (size < 0 || size > b.remaining()) break;
                int limit = b.limit();
                b.limit(b.position() + size);
                if (!first) sb.append(' ');
                first = false;
                decode(b, sb, depth + 1);
                b.position(b.limit());
                b.limit(limit);
            }
            sb.append('}');
            return;
        }
        b.position(start);
        String address = readString(b);
        sb.append(address);
        if (!b.hasRemaining()) return;

        String tags = readString(b);
        if (tags.isEmpty() || tags.charAt(0) != ',') return;
        for (int i = 1; i < tags.length(); i++) {
            sb.append(' ');
            switch (tags.charAt(i)) {
                case 'i' -> sb.append(b.getInt());
                case 'f' -> sb.append(fmt(b.getFloat()));
                case 'd' -> sb.append(fmt(b.getDouble()));
                case 'h' -> sb.append(b.getLong());
                case 's', 'S' -> sb.append('"').append(readString(b)).append('"');
                case 'b' -> { int n = b.getInt(); skip(b, pad(n)); sb.append("<blob ").append(n).append('>'); }
                case 't' -> sb.append("<time ").append(b.getLong()).append('>');
                case 'c' -> sb.append('\'').append((char) b.getInt()).append('\'');
                case 'r', 'm' -> sb.append(String.format("0x%08x", b.getInt()));
                case 'T' -> sb.append("true");
                case 'F' -> sb.append("false");
                case 'N' -> sb.append("null");
                case 'I' -> sb.append("inf");
                default -> sb.append('?').append(tags.charAt(i));
            }
        }
    }

    /** Reads a null-terminated, 4-byte-aligned OSC string. */
    private static String readString(ByteBuffer b) {
        int start = b.position();
        int end = start;
        while (end < b.limit() && b.get(end) != 0) end++;
        if (end >= b.limit()) throw new IllegalArgumentException("unterminated string");
        byte[] bytes = new byte[end - start];
        b.get(bytes);
        // get() consumed the characters; step over the null and any alignment padding.
        skip(b, pad(bytes.length + 1) - bytes.length);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /** Total length of a field of {@code n} bytes once padded to a 4-byte boundary. */
    private static int pad(int n) {
        return (n + 3) & ~3;
    }

    private static void skip(ByteBuffer b, int n) {
        if (n > b.remaining()) throw new BufferUnderflowException();
        b.position(b.position() + n);
    }

    private static String fmt(double v) {
        return Math.abs(v) >= 1e9 ? String.format("%.3e", v) : String.format("%.3f", v);
    }
}
