// The missing adapter identified by the Linux backend audit
// (docs/linux-backend-client-contract.md §12): TunnelProxy.ts's DataChannel
// interface previously had only one real implementation
// (createLoopbackChannelPair, test-only). This is the real, production
// implementation — it backs a DataChannel with one RelaySignalingClient
// connection and one relay-data channelId, exactly as TunnelProxy.ts's own
// header comment always said it would.
//
// This file adds NO new protocol messages. It only calls the EXISTING
// RelaySignalingClient.sendData()/close() and listens to the EXISTING
// onRelayData/onRelayClosed callbacks, scoped to one channelId.
import { Buffer } from 'buffer';
import { RelaySignalingClient } from './RelaySignalingClient';
import { DataChannel } from './TunnelProxy';

export class RelayDataChannel implements DataChannel {
  private dataHandlers: ((d: Buffer) => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private closed = false;

  constructor(private client: RelaySignalingClient, private channelId: string) {}

  send(data: Buffer): void {
    if (this.closed) return;
    this.client.sendData(this.channelId, data);
  }

  onData(cb: (data: Buffer) => void): void { this.dataHandlers.push(cb); }
  onClose(cb: () => void): void { this.closeHandlers.push(cb); }

  close(): void {
    // The protocol (protocol.ts) defines no client-sendable "close this
    // channel" message — RelayClosedMessage exists only in the server→client
    // direction (see docs/linux-backend-client-contract.md §12, §20.7,
    // identified rather than worked around by inventing a new message
    // type). A closed local side simply stops sending/reading; the relay is
    // expected to reclaim the channel via RELAY_IDLE_TIMEOUT_MS once traffic
    // stops, matching how the rest of this app already treats idle timeouts
    // as the real cleanup mechanism (see FriendsPresenceLogic's heartbeat
    // timeout for the same pattern).
    if (this.closed) return;
    this.closed = true;
    this.closeHandlers.forEach((cb) => cb());
  }

  /** Called by whatever owns this channel's RelaySignalingClient (see
   *  RelayConnectionManager) when a real relay-data frame for THIS
   *  channelId arrives. Not part of the DataChannel interface — it's the
   *  manager-side half of the adapter, not something TunnelProxy calls. */
  handleIncomingData(data: Buffer): void {
    if (this.closed) return;
    this.dataHandlers.forEach((cb) => cb(data));
  }

  /** Called when the relay reports relay-closed for THIS channelId. */
  handleRemoteClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandlers.forEach((cb) => cb());
  }

  get id(): string { return this.channelId; }
}
