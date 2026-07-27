package com.ebremer.solarsystem;

import jakarta.websocket.Session;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketException;
import java.net.UnknownHostException;
import java.nio.ByteBuffer;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Bridges OSC between the browser and a UDP peer.
 *
 * <p>Browser to peer: osc.js in the page encodes real OSC packets and pushes them down a
 * WebSocket as binary frames; this class relays those bytes verbatim into a UDP datagram.
 * No re-encoding happens, so whatever osc.js produced is exactly what the receiving
 * application sees.
 *
 * <p>Peer to browser: datagrams arriving on the listen port are pushed to every connected
 * WebSocket client, which lets a patch talk back to the visualisation.
 */
public final class OscUdpBridge implements AutoCloseable {

    private static final int MAX_DATAGRAM = 65507;

    /**
     * How often to ping idle WebSocket clients. A backgrounded tab stops calling
     * requestAnimationFrame and therefore stops sending OSC, which would otherwise trip
     * Jetty's idle timeout. Browsers answer a ping frame with a pong automatically, so
     * this keeps the connection alive without putting anything on the OSC wire.
     */
    private static final long PING_INTERVAL_SECONDS = 20;

    private final Config config;
    private final DatagramSocket socket;
    private final Set<Session> clients = new CopyOnWriteArraySet<>();
    private final Thread receiver;
    private final ScheduledExecutorService keepAlive;
    private volatile boolean running = true;

    private final AtomicLong packetsOut = new AtomicLong();
    private final AtomicLong bytesOut = new AtomicLong();
    private final AtomicLong packetsIn = new AtomicLong();
    private final AtomicLong dropped = new AtomicLong();

    public OscUdpBridge(Config config) throws SocketException, UnknownHostException {
        this.config = config;
        this.socket = openSocket(config);
        if (config.oscListenPort > 0) {
            receiver = new Thread(this::receiveLoop, "osc-udp-receiver");
            receiver.setDaemon(true);
            receiver.start();
        } else {
            receiver = null;
        }
        keepAlive = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "osc-ws-keepalive");
            t.setDaemon(true);
            return t;
        });
        keepAlive.scheduleWithFixedDelay(this::pingClients,
                PING_INTERVAL_SECONDS, PING_INTERVAL_SECONDS, TimeUnit.SECONDS);
    }

    private void pingClients() {
        for (Session session : clients) {
            if (!session.isOpen()) { clients.remove(session); continue; }
            try {
                session.getAsyncRemote().sendPing(ByteBuffer.allocate(0));
            } catch (IOException | IllegalArgumentException e) {
                clients.remove(session);
            }
        }
    }

    private static DatagramSocket openSocket(Config config) throws SocketException, UnknownHostException {
        if (config.oscListenPort <= 0) {
            return new DatagramSocket(); // ephemeral source port, send only
        }
        InetAddress bind = InetAddress.getByName(config.bindHost);
        try {
            return new DatagramSocket(new InetSocketAddress(bind, config.oscListenPort));
        } catch (SocketException e) {
            System.err.println("  ! UDP port " + config.oscListenPort + " is unavailable ("
                    + e.getMessage() + "); inbound OSC disabled.");
            config.oscListenPort = 0;
            return new DatagramSocket();
        }
    }

    /** The port datagrams actually leave from, which is where an OSC peer should reply. */
    public int localPort() {
        return socket.getLocalPort();
    }

    public void addClient(Session session) {
        clients.add(session);
    }

    public void removeClient(Session session) {
        clients.remove(session);
    }

    public int clientCount() {
        return clients.size();
    }

    /** Forwards one already-encoded OSC packet to the configured UDP destination. */
    public void sendToPeer(ByteBuffer packet) {
        int length = packet.remaining();
        if (length == 0) return;
        if (length > MAX_DATAGRAM) {
            dropped.incrementAndGet();
            System.err.println("  ! dropping " + length + " byte packet, exceeds UDP maximum");
            return;
        }
        byte[] data = new byte[length];
        packet.duplicate().get(data);
        try {
            InetAddress target = InetAddress.getByName(config.oscHost);
            socket.send(new DatagramPacket(data, length, target, config.oscPort));
            packetsOut.incrementAndGet();
            bytesOut.addAndGet(length);
            if (config.verbose) {
                System.out.println("  -> " + config.oscHost + ":" + config.oscPort + "  "
                        + OscPeek.describe(ByteBuffer.wrap(data)));
            }
        } catch (IOException e) {
            dropped.incrementAndGet();
            // A closed/unreachable destination is normal for UDP; log once in a while only.
            if (dropped.get() % 100 == 1) {
                System.err.println("  ! UDP send to " + config.oscHost + ":" + config.oscPort
                        + " failed: " + e.getMessage());
            }
        }
    }

    private void receiveLoop() {
        byte[] buffer = new byte[MAX_DATAGRAM];
        while (running) {
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            try {
                socket.receive(packet);
            } catch (IOException e) {
                if (running) System.err.println("  ! UDP receive failed: " + e.getMessage());
                continue;
            }
            byte[] data = new byte[packet.getLength()];
            System.arraycopy(packet.getData(), packet.getOffset(), data, 0, data.length);
            packetsIn.incrementAndGet();
            if (config.verbose) {
                System.out.println("  <- " + packet.getAddress().getHostAddress() + ":" + packet.getPort()
                        + "  " + OscPeek.describe(ByteBuffer.wrap(data)));
            }
            for (Session session : clients) {
                if (!session.isOpen()) { clients.remove(session); continue; }
                // Each client needs its own buffer: async sends read it after this call returns.
                session.getAsyncRemote().sendBinary(ByteBuffer.wrap(data.clone()));
            }
        }
    }

    /** Changes the UDP destination. Returns an error message, or null on success. */
    public String retarget(String host, int port) {
        if (!config.allowRetarget) return "retargeting is disabled (--no-retarget)";
        if (port < 1 || port > 65535) return "port out of range: " + port;
        try {
            InetAddress.getByName(host);
        } catch (UnknownHostException e) {
            return "unknown host: " + host;
        }
        config.oscHost = host;
        config.oscPort = port;
        System.out.println("  * OSC destination is now " + host + ":" + port);
        return null;
    }

    public String statsJson() {
        return "{\"packetsOut\":" + packetsOut.get()
                + ",\"bytesOut\":" + bytesOut.get()
                + ",\"packetsIn\":" + packetsIn.get()
                + ",\"dropped\":" + dropped.get()
                + ",\"clients\":" + clients.size()
                + ",\"sourcePort\":" + localPort() + "}";
    }

    @Override
    public void close() {
        running = false;
        keepAlive.shutdownNow();
        socket.close();
        if (receiver != null) receiver.interrupt();
    }
}
