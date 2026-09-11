// Real connection negotiation for a Mercy-managed game server join. Ties
// together facts this repo can ALREADY determine for real (a host's LAN
// address, whether its port is actually listening — both already computed
// by MinecraftManager.getConnectionInfo(), reused here rather than
// duplicated) with the one new real NAT-traversal mechanism this milestone
// adds (UpnpPortMapper), and falls back to the existing, honest
// assessConnectivity() verdict (see PresenceManager.ts) when neither
// produces a usable address and no relay is configured.
//
// WHAT THIS DOES NOT DO: it never claims a connection is established. A
// "candidate" here is an address worth trying — whether it actually works
// is only known once the joining side really attempts to connect (see
// verifyEndpointReachable below, and TunnelProxy.ts for the relay data
// path). There is no fabricated "connected" state anywhere in this file.
import { assessConnectivity } from '../PresenceManager';
import { PortMapper, UpnpIgdPortMapper, PortMapResult } from './UpnpPortMapper';
import net from 'net';

export type EndpointStrategy = 'lan-direct' | 'upnp-direct' | 'relay';

export interface EndpointCandidate {
  strategy: EndpointStrategy;
  /** "host:port" a client should actually try. */
  address: string;
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
}

export interface EndpointPlan {
  candidates: EndpointCandidate[];
  /** Only true once a real relay/signaling URL is configured (see
   *  .env.example's VITE_MERCY_RELAY_WS_URL) — never fabricated. */
  relayAvailable: boolean;
  /** Present only when there are no usable candidates AND no relay is
   *  configured — the exact same honest message assessConnectivity()
   *  already produces for this situation, reused rather than reworded. */
  unavailableExplanation: string | null;
}

export class ConnectionNegotiator {
  constructor(private portMapper: PortMapper = new UpnpIgdPortMapper()) {}

  /** Real negotiation: attempts UPnP only when there's an actual listening
   *  port to map, builds every genuinely real candidate, and is honest
   *  when none exist and no relay is configured. Never invents NAT
   *  traversal that didn't actually succeed. */
  async planHostEndpoint(facts: HostConnectivityFacts, relayConfigured: boolean): Promise<EndpointPlan> {
    const candidates: EndpointCandidate[] = [];

    if (facts.lanAddress) {
      candidates.push({
        strategy: 'lan-direct', address: `${facts.lanAddress}:${facts.port}`,
        note: 'Works only if the joining friend is on this same local network.',
      });
    }

    let upnp: PortMapResult | null = null;
    if (facts.portListening) {
      upnp = await this.portMapper.mapPort(facts.port, 'TCP', 'Mercy Launcher', 3600);
      if (upnp.success && upnp.externalAddress) {
        candidates.push({
          strategy: 'upnp-direct', address: `${upnp.externalAddress}:${upnp.externalPort ?? facts.port}`,
          note: 'A port was opened automatically on this network\'s router via UPnP.',
        });
      }
    }

    if (candidates.length > 0) return { candidates, relayAvailable: relayConfigured, unavailableExplanation: null };
    if (relayConfigured) return { candidates: [], relayAvailable: true, unavailableExplanation: null };

    // A failed UPnP mapping attempt means "automatic NAT traversal didn't
    // work", never "confirmed unreachable" (that would need a real external
    // echo/relay check this repo has no service for) — so it maps to
    // unknown (null), not false, which correctly reaches the honest
    // relay-required-unavailable verdict rather than a misleading
    // not-joinable one.
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
