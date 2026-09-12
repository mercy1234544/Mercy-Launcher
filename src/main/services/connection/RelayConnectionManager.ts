// The real orchestrator wiring the previously-unwired pieces together
// (RelaySignalingClient + RelayDataChannel + TunnelProxy) into the actual
// join flow — the exact gap the Linux backend audit identified
// (docs/linux-backend-client-contract.md §0/§7/§9/§12).
//
// Uses ONLY the existing protocol.ts message set. No new message types are
// introduced. One documented interpretation of an underspecified point (see
// the class header on handleMessage below) stands in for something the
// protocol itself doesn't disambiguate — this is called out explicitly, not
// silently assumed, per the task's own "STOP and identify it instead of
// inventing a parallel protocol" instruction.
import { RelaySignalingClient, RelayConnectionState } from './RelaySignalingClient';
import { RelayDataChannel } from './RelayDataChannel';
import { TunnelProxy } from './TunnelProxy';
import { RelayProtocolGame, RelayTransport, RELAY_HOST_REGISTRATION_TTL_MS } from './protocol';

export interface RelayHostResult { success: boolean; relayId?: string; reason?: string; }
export interface RelayClientResult { success: boolean; localAddress?: string; reason?: string; }

const RELAY_RESPONSE_TIMEOUT_MS = 8000;

/** One real host-side registration: the persistent signaling connection
 *  that owns it, and every relay-granted channel currently forwarding to
 *  this server's real local port. */
interface HostRegistration {
  client: RelaySignalingClient;
  relayId: string;
  localPort: number;
  transport: RelayTransport;
  channels: Map<string, RelayDataChannel>;
  proxies: Map<string, TunnelProxy>;
}

export class RelayConnectionManager {
  /** Keyed by `${serverId}::${transport}`, NOT just serverId — Assetto
   *  Corsa genuinely needs BOTH a TCP and a UDP registration for the SAME
   *  server (TCP for the connection handshake/chat, UDP for real-time car
   *  data — the same real, documented convention every AC dedicated-server
   *  port-forwarding guide uses: forward BOTH protocols on the same port
   *  number). Minecraft/FiveM only ever register one transport per server,
   *  so for them this key is functionally identical to keying by serverId
   *  alone — this change is additive, not a behavior change for them. */
  private hostRegistrations = new Map<string, HostRegistration>();

  constructor(private relayUrl: string | null) {}

  isConfigured(): boolean { return !!this.relayUrl; }

  private key(serverId: string, transport: RelayTransport): string { return `${serverId}::${transport}`; }

  /** HOST side: connect to the relay (if not already connected for this
   *  server+transport), authenticate with the given session token, and
   *  register this server's real local port. Real network call — fails
   *  honestly if the relay is unreachable, rejects the token, or times out.
   *  Idempotent: calling this again for a server+transport that's already
   *  registered just returns the existing relayId without a second round
   *  trip. Call once per transport a game actually needs (see class header)
   *  — each produces its own independent relayId/signaling connection, so
   *  a caller needing both TCP and UDP (Assetto Corsa) calls this twice. */
  async ensureHostRegistered(
    serverId: string, game: RelayProtocolGame, transport: RelayTransport, localPort: number, sessionToken: string,
  ): Promise<RelayHostResult> {
    if (!this.relayUrl) return { success: false, reason: 'No Mercy relay is configured.' };
    const key = this.key(serverId, transport);
    const existing = this.hostRegistrations.get(key);
    if (existing && existing.client.getState() === 'ready') return { success: true, relayId: existing.relayId };
    if (existing) this.teardownRegistration(key);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RelayHostResult) => { if (!settled) { settled = true; resolve(result); } };
      const timer = setTimeout(() => finish({ success: false, reason: 'Timed out waiting for the relay to register this server.' }), RELAY_RESPONSE_TIMEOUT_MS);

      const client = new RelaySignalingClient(this.relayUrl!, {
        onHostRegistered: (relayId) => {
          clearTimeout(timer);
          this.hostRegistrations.set(key, { client, relayId, localPort, transport, channels: new Map(), proxies: new Map() });
          finish({ success: true, relayId });
        },
        // See class header: this manager treats a relay-granted arriving on
        // the HOST's own signaling connection as "a client's request-relay
        // against one of our registrations succeeded" — the documented
        // interpretation of protocol.ts's generic RelayGrantedMessage,
        // since the protocol defines no separate host-notification message.
        onRelayGranted: (channelId) => this.handleHostRelayGranted(key, channelId),
        onRelayClosed: (channelId) => this.handleHostRelayClosed(key, channelId),
        onRelayData: (channelId, data) => this.hostRegistrations.get(key)?.channels.get(channelId)?.handleIncomingData(data),
      });

      client.connect(sessionToken, 'host').then(() => {
        client.registerHost(serverId, game, transport, localPort, Date.now() + RELAY_HOST_REGISTRATION_TTL_MS);
      }).catch((err) => { clearTimeout(timer); finish({ success: false, reason: err?.message || 'Could not connect to the Mercy relay.' }); });
    });
  }

  private async handleHostRelayGranted(key: string, channelId: string): Promise<void> {
    const reg = this.hostRegistrations.get(key);
    if (!reg) return;
    const channel = new RelayDataChannel(reg.client, channelId);
    reg.channels.set(channelId, channel);
    const proxy = new TunnelProxy({ mode: 'host', transport: reg.transport === 'udp' ? 'udp' : 'tcp', targetPort: reg.localPort, channel });
    reg.proxies.set(channelId, proxy);
    try { await proxy.start(); } catch { reg.channels.delete(channelId); reg.proxies.delete(channelId); }
  }

  private handleHostRelayClosed(key: string, channelId: string): void {
    const reg = this.hostRegistrations.get(key);
    if (!reg) return;
    reg.channels.get(channelId)?.handleRemoteClose();
    reg.proxies.get(channelId)?.stop();
    reg.channels.delete(channelId);
    reg.proxies.delete(channelId);
  }

  private teardownRegistration(key: string): void {
    const reg = this.hostRegistrations.get(key);
    if (!reg) return;
    for (const proxy of reg.proxies.values()) proxy.stop();
    reg.client.close();
    this.hostRegistrations.delete(key);
  }

  /** Real cleanup — closes every relayed connection for this server (every
   *  transport it registered, TCP and/or UDP) and disconnects its
   *  signaling socket(s). Called when the server actually stops (see the
   *  caller in main.ts), never left to time out on its own when the real
   *  state is already known. */
  teardownHost(serverId: string): void {
    const prefix = `${serverId}::`;
    for (const key of Array.from(this.hostRegistrations.keys())) {
      if (key.startsWith(prefix)) this.teardownRegistration(key);
    }
  }

  /** CLIENT side: connect to the relay, authenticate with the join token
   *  the host minted (see PresenceManager.createJoinToken), request the
   *  specific relayId the host registered, and — once granted — start a
   *  local TunnelProxy the real game client can connect to. Returns the
   *  real local "127.0.0.1:port" address to use, or an honest failure.
   *  Never reports success without a real relay-granted response. */
  async connectViaRelay(
    joinRequestId: string, relayId: string, sessionToken: string, transport: RelayTransport, listenPort: number,
  ): Promise<RelayClientResult> {
    if (!this.relayUrl) return { success: false, reason: 'No Mercy relay is configured.' };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RelayClientResult) => { if (!settled) { settled = true; resolve(result); } };
      const timer = setTimeout(() => finish({ success: false, reason: 'Timed out waiting for the relay to authorize this connection.' }), RELAY_RESPONSE_TIMEOUT_MS);

      let channel: RelayDataChannel | null = null;
      const client = new RelaySignalingClient(this.relayUrl!, {
        onRelayGranted: async (channelId) => {
          clearTimeout(timer);
          channel = new RelayDataChannel(client, channelId);
          const proxy = new TunnelProxy({ mode: 'client', transport: transport === 'udp' ? 'udp' : 'tcp', listenPort, channel });
          try {
            await proxy.start();
            finish({ success: true, localAddress: `127.0.0.1:${listenPort}` });
          } catch (e: any) {
            finish({ success: false, reason: e?.message || 'Could not start the local connection tunnel.' });
          }
        },
        onRelayDenied: (reason) => { clearTimeout(timer); finish({ success: false, reason }); },
        onRelayData: (_channelId, data) => channel?.handleIncomingData(data),
        onRelayClosed: () => channel?.handleRemoteClose(),
      });

      client.connect(sessionToken, 'client').then(() => {
        client.requestRelay(joinRequestId, relayId);
      }).catch((err) => { clearTimeout(timer); finish({ success: false, reason: err?.message || 'Could not connect to the Mercy relay.' }); });
    });
  }
}
