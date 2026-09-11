// Real local tunnel proxy — the actual mechanism by which "the game
// believes it's connecting to a normal endpoint while Mercy handles the
// transport underneath" (Phase 3) is implemented, for the relay case.
//
// Two real proxies exist per relayed connection:
//   HOST side:   TunnelProxy in 'host' mode — connects OUT to the real local
//                game server (127.0.0.1:realPort) whenever the relay hands
//                it a new logical connection, and forwards bytes both ways.
//   CLIENT side: TunnelProxy in 'client' mode — listens on a real local
//                port; the game client (Minecraft, etc.) connects to
//                that as if it were the real server, and every byte is
//                forwarded through the same DataChannel to the host side.
//
// TRANSPORT: 'tcp' (net) is used for Java Edition, FiveM, and Assetto
// Corsa's TCP query port. 'udp' (dgram) exists specifically because Bedrock
// Edition is RakNet-over-UDP — a TCP proxy is structurally incapable of
// carrying it (confirmed against MinecraftManager's own real RakNet ping,
// which already uses dgram for exactly this reason). UDP has no
// "connection" concept, so the UDP proxy is a real reflector: 'client' mode
// remembers the most recent real sender address and mirrors channel data
// back to it; 'host' mode sends to the real local target and forwards
// whatever comes back on the resulting ephemeral socket. This means a
// 'client'-mode UDP proxy serves ONE active remote peer at a time, which
// matches this class's own one-tunnel-per-connection design (see
// createLoopbackChannelPair's tests for why a fresh TunnelProxy pair is
// created per logical connection rather than one shared instance).
//
// DataChannel is deliberately abstract: in production it's backed by a
// RelaySignalingClient's relay-data frames via RelayDataChannel.ts (see
// protocol.ts); in tests it's a plain in-memory pair, which is what proves
// this forwarding logic is correct without needing a deployed relay (see
// test/connection/tunnelProxy.test.js — real local TCP/UDP "game server"
// stand-ins are used, so the byte-forwarding path is genuinely exercised
// end-to-end, only the relay hop itself is faked).
import net from 'net';
import dgram from 'dgram';

export interface DataChannel {
  send(data: Buffer): void;
  onData(cb: (data: Buffer) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** A trivial same-process DataChannel pair — stands in for "the relay" in
 *  tests. Never used in production (production always goes through a real
 *  RelaySignalingClient's WebSocket-backed channel). */
export function createLoopbackChannelPair(): [DataChannel, DataChannel] {
  const aData: ((d: Buffer) => void)[] = [];
  const bData: ((d: Buffer) => void)[] = [];
  const aClose: (() => void)[] = [];
  const bClose: (() => void)[] = [];
  const a: DataChannel = {
    send: (d) => bData.forEach((cb) => cb(d)),
    onData: (cb) => aData.push(cb),
    onClose: (cb) => aClose.push(cb),
    close: () => bClose.forEach((cb) => cb()),
  };
  const b: DataChannel = {
    send: (d) => aData.forEach((cb) => cb(d)),
    onData: (cb) => bData.push(cb),
    onClose: (cb) => bClose.push(cb),
    close: () => aClose.forEach((cb) => cb()),
  };
  return [a, b];
}

export interface TunnelProxyOptions {
  /** 'client' listens locally and forwards to the channel; 'host' connects
   *  to a real local target and forwards to the channel. */
  mode: 'client' | 'host';
  /** Defaults to 'tcp' — every caller before Bedrock support existed. */
  transport?: 'tcp' | 'udp';
  /** 'client' mode only — the local port to listen on for the game client. */
  listenPort?: number;
  /** 'host' mode only — the real local game server port to forward to. */
  targetPort?: number;
  channel: DataChannel;
}

/** Real byte-for-byte forwarding between one local socket and one
 *  DataChannel, over TCP or UDP. Never inspects or modifies game traffic —
 *  Mercy only ever moves bytes, exactly like a plain relay would. */
export class TunnelProxy {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private udpSocket: dgram.Socket | null = null;
  /** UDP 'client' mode only — the real remote peer's address, learned from
   *  the first real datagram received; there is no UDP "connection" to
   *  track it via otherwise. */
  private udpPeer: { address: string; port: number } | null = null;
  private closed = false;

  constructor(private options: TunnelProxyOptions) {}

  async start(): Promise<void> {
    const { mode, channel } = this.options;
    const transport = this.options.transport ?? 'tcp';
    channel.onClose(() => this.stop());

    if (transport === 'udp') return mode === 'client' ? this.startUdpClient(channel) : this.startUdpHost(channel);
    return mode === 'client' ? this.startTcpClient(channel) : this.startTcpHost(channel);
  }

  private async startTcpClient(channel: DataChannel): Promise<void> {
    if (!this.options.listenPort) throw new Error('listenPort is required in client mode.');
    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((sock) => {
        this.socket = sock;
        sock.on('data', (d) => channel.send(d));
        sock.on('close', () => { if (!this.closed) channel.close(); });
        sock.on('error', () => {});
      });
      this.server.once('error', reject);
      this.server.listen(this.options.listenPort, '127.0.0.1', () => resolve());
    });
    channel.onData((d) => { this.socket?.write(d); });
  }

  private async startTcpHost(channel: DataChannel): Promise<void> {
    // Connects out to the real local game server the moment the channel is
    // established (mirrors a real client actually connecting).
    if (!this.options.targetPort) throw new Error('targetPort is required in host mode.');
    await new Promise<void>((resolve, reject) => {
      this.socket = net.createConnection({ host: '127.0.0.1', port: this.options.targetPort! }, () => resolve());
      this.socket.once('error', reject);
      this.socket.on('data', (d) => channel.send(d));
      this.socket.on('close', () => { if (!this.closed) channel.close(); });
    });
    channel.onData((d) => { this.socket?.write(d); });
  }

  private async startUdpClient(channel: DataChannel): Promise<void> {
    if (!this.options.listenPort) throw new Error('listenPort is required in client mode.');
    await new Promise<void>((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4');
      this.udpSocket.once('error', reject);
      this.udpSocket.on('message', (msg, rinfo) => {
        // Real, not assumed: every datagram carries its own real sender
        // address — this is exactly how a UDP "connection" is tracked,
        // since the protocol itself has none.
        this.udpPeer = { address: rinfo.address, port: rinfo.port };
        channel.send(msg);
      });
      this.udpSocket.bind(this.options.listenPort, '127.0.0.1', () => resolve());
    });
    channel.onData((d) => { if (this.udpPeer) this.udpSocket?.send(d, this.udpPeer.port, this.udpPeer.address); });
  }

  private async startUdpHost(channel: DataChannel): Promise<void> {
    if (!this.options.targetPort) throw new Error('targetPort is required in host mode.');
    const targetPort = this.options.targetPort;
    this.udpSocket = dgram.createSocket('udp4');
    this.udpSocket.on('message', (msg) => channel.send(msg));
    this.udpSocket.on('error', () => {});
    channel.onData((d) => { this.udpSocket?.send(d, targetPort, '127.0.0.1'); });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.destroy(); } catch {}
    try { this.server?.close(); } catch {}
    try { this.udpSocket?.close(); } catch {}
  }
}
