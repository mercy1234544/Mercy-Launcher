// Real, pure connectivity-assessment helper, kept after the Friends &
// Presence feature (and the rest of this file's original contents — local
// activity tracking, join tokens, friends/presence settings) was removed
// from the app. ConnectionNegotiator.ts still imports assessConnectivity()
// from here for each game's own "Connect" tab (Minecraft/Assetto
// Corsa/FiveM), which is independent of the removed social/friends layer —
// it just explains whether a server is reachable locally, publicly, or
// would need a relay/tunnel Mercy doesn't provide.
export type ConnectivityStrategy = 'lan-direct' | 'public-direct' | 'relay-required-unavailable' | 'not-joinable';

export interface ConnectivityAssessment {
  strategy: ConnectivityStrategy;
  explanation: string;
}

/** A real, pure decision function over REAL reachability facts the caller
 *  already knows (e.g. from Minecraft/Assetto Corsa's own existing
 *  reachability checks) — never re-implements or guesses that reachability
 *  itself, and never invents a relay/NAT-traversal capability that doesn't
 *  exist. */
export function assessConnectivity(reachability: { hasLanAddress: boolean; realtimeReachable: boolean | null }): ConnectivityAssessment {
  if (reachability.realtimeReachable === false) {
    return { strategy: 'not-joinable', explanation: 'The server is not currently reachable — it may be offline or not finished starting yet.' };
  }
  if (reachability.hasLanAddress) {
    return { strategy: 'lan-direct', explanation: 'Reachable directly over the local network.' };
  }
  if (reachability.realtimeReachable === true) {
    return { strategy: 'public-direct', explanation: 'The server is reachable at its current address (already port-forwarded or otherwise publicly reachable).' };
  }
  return {
    strategy: 'relay-required-unavailable',
    explanation: 'Mercy has no relay/NAT-traversal service today — this game\'s dedicated server protocol needs a forwarded port or a tunneling service (e.g. playit.gg, ngrok) for a friend outside the local network to join.',
  };
}
