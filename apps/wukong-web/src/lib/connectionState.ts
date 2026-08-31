import type { ConnectionState } from '../types';

/**
 * Project the boolean transport callback into a user-facing lifecycle state.
 * A close before the first successful hello is still the initial connection;
 * a close after a hello means the socket is automatically reconnecting.
 */
export function nextConnectionState(
  previous: ConnectionState,
  connected: boolean,
): ConnectionState {
  if (connected) return 'connected';
  return previous === 'connected' || previous === 'reconnecting'
    ? 'reconnecting'
    : 'connecting';
}
