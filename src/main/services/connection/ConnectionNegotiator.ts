// Real connection negotiation for a Mercy-managed game server join. Ties
// together facts this repo can ALREADY determine for real (a host's LAN
// address, whether its port is actually listening — both already computed
// by MinecraftManager.getConnectionInfo(), reused here rather than
// duplicated), the real NAT-traversal mechanism (UpnpPortMapper), and — now
// — the real Mercy relay (RelayConnectionManager), falling back to the
// existing, honest assessConnectivity() verdict (see PresenceManager.ts)
// only when nothing actually works.
//
// PRIORITY (never reordered): LAN-direct, then UPnP-direct, then relay —
// direct connections are always preferred; the relay is only ever attempted
// once both direct options have genuinely failed, per the explicit
// "Direct connections should remain preferred" requirement.
//
// WHAT THIS DOES NOT DO: it never claims a connection is established, and
// it never reports the relay as available without a real, completed
// registration round trip. A "candidate" here is an address/route worth
// trying — whether it actually works is only known once the joining side
// really attempts to connect (see verifyEndpointReachable below, and
// TunnelProxy.ts for the relay data path). There is no fabricated
// "connected" state anywhere in this file.
import { assessConnectivity } from '../PresenceManager';
import { PortMapper, UpnpIgdPortMapper, PortMapResult } from './UpnpPortMapper';
import { RelayConnectionManager } from './RelayConnectionManager';
import { RelayProtocolGame, RelayTransport } from './protocol';
import net from 'net';

export type EndpointStrategy = 'lan-direct' | 'upnp-direct' | 'relay';

export interface EndpointCandidate {
  strategy: EndpointStrategy;
  /** "host:port" a client should actually try, for lan-direct/upnp-direct.
   *  For 'relay', a human-readable placeholder — the real thing the client
   *  needs is `relayId`, not an address (there is no host:port for a
   *  relayed connection until TunnelProxy is actually running locally). */
  address: string;
  /** 'relay' only — the real relay's own identifier for this host
   *  registration, required by the joining side's connectViaRelay() call. */
  relayId?: string;
  /** Set only when a SECOND, independent UDP relay registration exists for
   *  the same server alongside the primary (TCP) one — Assetto Corsa needs
   *  both a TCP and a UDP relay channel to the same real port (see
   *  RelayConnectionManager's own header on why). Absent for every other
   *  game today, which only ever needs one transport. Never set by
   *  planHostEndpoint() itself (this is a single-transport function) — only
   *  by a caller that explicitly negotiated a second transport, such as
   *  main.ts's Assetto-Corsa-specific negotiation handler. */
  relayIdUdp?: string;
  note: string;
}

export interface HostConnectivityFacts {
  /** This machine's real, non-internal LAN IPv4 address, or null. Reuses
   *  the same detection MinecraftManager.getConnectionInfo() already does —
   *  never re-implemented here. */
  lanAddress: string | null;
  port: number;
  /** Whether the real local port is actually accepting connections right
   *  now (from MinecraftManager.getConnectionInfo()'s own real TCP probe /
   *  RakNet ping) — attempting UPnP for a port nothing is listening on
   *  would be pointless and misleading. */
  portListening: boolean | null;
  /** Defaults to 'tcp'. Bedrock is 'udp' — see TunnelProxy.ts's own header
   *  for why a TCP proxy cannot carry RakNet traffic. */
  transport?: RelayTransport;
}

/** Everything needed to actually attempt a real relay registration — never
 *  just a boolean "is a relay configured" flag, because a configured-but-
 *  unreachable/rejecting relay must still resolve to an honest failure, not
 *  a false "available". Pass null when no relay is configured at all. */
export interface RelayRegistrationRequest {
  manager: RelayConnectionManager;
  serverId: string;
  game: RelayProtocolGame;
  /** The host's own session token for authenticating to the relay — see
   *  PresenceManager.createJoinToken(), minted by the caller (main.ts). */
  sessionToken: string;
}

export interface EndpointPlan {
  candidates: EndpointCandidate[];
  /** True only once a relay candidate was ACTUALLY produced by a real,
   *  successful registration — never merely because a relay URL exists in
   *  configuration. See the "Do NOT falsely report a relay as available"
   *  requirement this field exists to satisfy. */
  relayAvailable: boolean;
  /** Present only when there are no usable candidates at all (direct, UPnP,
   *  or relay) — the exact same honest message assessConnectivity() already
   *  produces for the direct/UPnP case, or the relay's own real failure
   *  reason when a relay was attempted and failed. */
  unavailableExplanation: string | null;
}

export class ConnectionNegotiator {
  constructor(private portMapper: PortMapper = new UpnpIgdPortMapper()) {}

  /** Real negotiation, direct-first: LAN, then UPnP (only if the port is
   *  actually listening), then — only once both have failed — a real relay
   *  registration attempt if one was configured. Never invents NAT
   *  traversal or a relay connection that didn't actually succeed. */
  async planHostEndpoint(facts: HostConnectivityFacts, relay: RelayRegistrationRequest | null): Promise<EndpointPlan> {
    const candidates: EndpointCandidate[] = [];

    if (facts.lanAddress) {
      candidates.push({
        strategy: 'lan-direct', address: `${facts.lanAddress}:${facts.port}`,
        note: 'Works only if the joining friend is on this same local network.',
      });
    }

    let upnp: PortMapResult | null = null;
    if (facts.portListening) {
      const protocol = facts.transport === 'udp' ? 'UDP' : 'TCP';
      upnp = await this.portMapper.mapPort(facts.port, protocol, 'Mercy Launcher', 3600);
      if (upnp.success && upnp.externalAddress) {
        candidates.push({
          strategy: 'upnp-direct', address: `${upnp.externalAddress}:${upnp.externalPort ?? facts.port}`,
          note: 'A port was opened automatically on this network\'s router via UPnP.',
        });
      }
    }

    if (candidates.length > 0) return { candidates, relayAvailable: false, unavailableExplanation: null };

    if (relay) {
      const result = await relay.manager.ensureHostRegistered(relay.serverId, relay.game, facts.transport ?? 'tcp', facts.port, relay.sessionToken);
      if (result.success && result.relayId) {
        return {
          candidates: [{ strategy: 'relay', address: `relay:${result.relayId}`, relayId: result.relayId, note: 'Connects through the Mercy relay service.' }],
          relayAvailable: true, unavailableExplanation: null,
        };
      }
      // A configured relay that failed to register is an honest failure,
      // not silently treated the same as "no relay configured at all".
      return { candidates: [], relayAvailable: false, unavailableExplanation: result.reason || 'Could not reach the Mercy relay.' };
    }

    // A failed UPnP mapping attempt means "automatic NAT traversal didn't
    // work", never "confirmed unreachable" (that would need a real external
    // echo/relay check) — so it maps to unknown (null), not false, which
    // correctly reaches the honest relay-required-unavailable verdict
    // rather than a misleading not-joinable one.
    const assessment = assessConnectivity({ hasLanAddress: false, realtimeReachable: upnp?.success ? true : null });
    return { candidates: [], relayAvailable: false, unavailableExplanation: assessment.explanation };
  }

  /** Real, generic TCP reachability probe — used by the JOINING side to
   *  find out (for real, never assumed) whether a candidate address
   *  actually works before telling the player to connect their game there.
   *  Symmetric to MinecraftManager's own checkPortListening(), just usable
   *  against a remote host rather than only 127.0.0.1. */
  static async verifyEndpointReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const finish = (result: boolean) => { if (done) return; done = true; try { socket.destroy(); } catch {} resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      try { socket.connect(port, host); } catch { finish(false); }
    });
  }
}
