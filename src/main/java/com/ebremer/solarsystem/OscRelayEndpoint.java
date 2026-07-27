package com.ebremer.solarsystem;

import jakarta.websocket.CloseReason;
import jakarta.websocket.Endpoint;
import jakarta.websocket.EndpointConfig;
import jakarta.websocket.Session;

import java.nio.ByteBuffer;

/**
 * WebSocket endpoint that osc.js connects to from the browser.
 *
 * <p>A browser cannot open a UDP socket, so the standard osc.js deployment is
 * {@code osc.WebSocketPort} in the page talking to a relay like this one, which puts the
 * packets on the wire as real UDP. Binary frames carry OSC packets and are passed straight
 * through to {@link OscUdpBridge}; nothing is parsed or rewritten.
 *
 * <p>This is the programmatic {@link Endpoint} form rather than an {@code @ServerEndpoint}
 * annotated POJO, because the annotation takes a compile-time constant and the path is a
 * runtime setting ({@code --ws-path}). Registering handlers explicitly also means the
 * container never has to reflect over this class, which keeps the native image simpler.
 *
 * <p>All state lives in the bridge, so one instance serves every connection.
 */
public class OscRelayEndpoint extends Endpoint {

    private static final int MAX_MESSAGE_BYTES = 64 * 1024;

    private final OscUdpBridge bridge;
    private final String path;

    public OscRelayEndpoint(OscUdpBridge bridge, String path) {
        this.bridge = bridge;
        this.path = path;
    }

    @Override
    public void onOpen(Session session, EndpointConfig endpointConfig) {
        session.setMaxBinaryMessageBufferSize(MAX_MESSAGE_BYTES);
        session.setMaxTextMessageBufferSize(MAX_MESSAGE_BYTES);

        session.addMessageHandler(ByteBuffer.class, bridge::sendToPeer);

        // osc.js only sends binary, but a text frame gets a clear answer in the log rather
        // than a silent drop, in case other tooling is pointed at this endpoint.
        session.addMessageHandler(String.class, message ->
                System.out.println("  ! ignoring text frame on " + path
                        + " (OSC must be sent as binary): " + abbreviate(message)));

        bridge.addClient(session);
        System.out.println("  * osc.js client connected (" + bridge.clientCount() + " total)");
    }

    @Override
    public void onClose(Session session, CloseReason reason) {
        bridge.removeClient(session);
        System.out.println("  * osc.js client disconnected (" + bridge.clientCount() + " remaining)");
    }

    @Override
    public void onError(Session session, Throwable error) {
        bridge.removeClient(session);
        if (isRoutineDisconnect(error)) return;
        System.err.println("  ! WebSocket error: " + error);
    }

    /**
     * A tab closing, a reload, or the server restarting under an open page all surface as
     * transport-level failures rather than clean closes. The browser reconnects by itself,
     * so reporting these as errors would be pure noise.
     */
    private static boolean isRoutineDisconnect(Throwable error) {
        for (Throwable t = error; t != null; t = t.getCause()) {
            String name = t.getClass().getSimpleName();
            if (name.contains("Timeout")
                    || name.equals("ClosedChannelException")
                    || name.equals("EofException")
                    || name.equals("EOFException")) {
                return true;
            }
            if (t.getCause() == t) break;
        }
        return false;
    }

    private static String abbreviate(String s) {
        return s.length() <= 120 ? s : s.substring(0, 120) + "...";
    }
}
