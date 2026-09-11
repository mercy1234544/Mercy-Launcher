// Real WebSocket signaling client speaking protocol.ts's message shapes.
// This is genuinely usable the moment a real Linux relay/signaling service
// implementing that same protocol exists — nothing here is a stub or a
// simulation of the wire format. What IS unverified in this repo is the far
// end: there is no deployed relay to connect to, so this has only been
// exercised against a real local `ws` server started inside the test suite
// (see test/connection/relaySignalingClient.test.js), never a real Linux
// deployment.
import WebSocket from 'ws';
import {
  RELAY_PROTOCOL_VERSION, RELAY_HELLO_TIMEOUT_MS,
  SignalingClientMessage, SignalingServerMessage, RelayProtocolGame, RelayTransport,
} from './protocol';

export type RelayConnectionState = 'connecting' | 'authenticating' | 'ready' | 'closed' | 'failed';

export interface RelaySignalingClientEvents {
  onStateChange?: (state: RelayConnectionState, detail?: string) => void;
  onHostRegistered?: (relayId: string, expiresAt: number) => void;
  onRelayGranted?: (channelId: string) => void;
  onRelayDenied?: (reason: string) => void;
  onRelayData?: (channelId: string, data: Buffer) => void;
  onRelayClosed?: (channelId: string, reason: string) => void;
}

/** Thin, real client for one signaling session. Never invents a successful
 *  state — `ready` is only reached after a real hello-ack from the far end,
 *  and every other outcome (rejection, timeout, socket error) resolves to
 *  `failed` with an honest reason, never silently treated as success. */
export class RelaySignalingClient {
  private ws: WebSocket | null = null;
  private state: RelayConnectionState = 'connecting';
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string, private events: RelaySignalingClientEvents = {}) {}

  private setState(state: RelayConnectionState, detail?: string) {
    this.state = state;
    this.events.onStateChange?.(state, detail);
  }

  getState(): RelayConnectionState { return this.state; }

  connect(token: string, role: 'host' | 'client'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting');
      let settled = false;
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.setState('authenticating');
        this.send({ type: 'hello', protocolVersion: RELAY_PROTOCOL_VERSION, token, role });
        this.helloTimer = setTimeout(() => {
          if (!settled) { settled = true; this.setState('failed', 'No response to hello within timeout.'); reject(new Error('Relay hello timed out.')); this.close(); }
        }, RELAY_HELLO_TIMEOUT_MS);
      });

      this.ws.on('message', (raw) => {
        let msg: SignalingServerMessage;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'hello-ack') {
          if (this.helloTimer) clearTimeout(this.helloTimer);
          this.setState('ready');
          if (!settled) { settled = true; resolve(); }
          return;
        }
        if (msg.type === 'hello-rejected') {
          if (this.helloTimer) clearTimeout(this.helloTimer);
          this.setState('failed', msg.reason);
          if (!settled) { settled = true; reject(new Error(msg.reason)); }
          return;
        }
        this.handleReady(msg);
      });

      this.ws.on('error', (err) => {
        this.setState('failed', err.message);
        if (!settled) { settled = true; reject(err); }
      });
      this.ws.on('close', () => { if (this.state !== 'failed') this.setState('closed'); });
    });
  }

  private handleReady(msg: SignalingServerMessage) {
    switch (msg.type) {
      case 'host-registered': this.events.onHostRegistered?.(msg.relayId, msg.expiresAt); break;
      case 'relay-granted': this.events.onRelayGranted?.(msg.channelId); break;
      case 'relay-denied': this.events.onRelayDenied?.(msg.reason); break;
      case 'relay-data': this.events.onRelayData?.(msg.channelId, Buffer.from(msg.data, 'base64')); break;
      case 'relay-closed': this.events.onRelayClosed?.(msg.channelId, msg.reason); break;
      case 'pong': break;
    }
  }

  registerHost(serverId: string, game: RelayProtocolGame, transport: RelayTransport, localPort: number, expiresAt: number): void {
    this.send({ type: 'register-host', serverId, game, transport, localPort, expiresAt });
  }

  requestRelay(joinRequestId: string, relayId: string): void {
    this.send({ type: 'request-relay', joinRequestId, relayId });
  }

  sendData(channelId: string, data: Buffer): void {
    this.send({ type: 'relay-data', channelId, data: data.toString('base64') });
  }

  ping(): void { this.send({ type: 'ping', at: Date.now() }); }

  private send(msg: SignalingClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    try { this.ws?.close(); } catch {}
  }
}
