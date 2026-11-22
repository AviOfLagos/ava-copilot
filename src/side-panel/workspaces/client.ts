import { useEffect, useState } from 'react';
import { emptyPlacementState, placementStorage } from '@extension/storage';
import type { PlacementState } from '@extension/storage';

/**
 * Sends a command to the background, which is the only writer of what moves where (src/background/workspaces).
 * Resolves with the command's result, rejects with the background's error.
 */
export async function workspacesRequest<T = unknown>(
  message: { type: `workspaces_${string}` } & Record<string, unknown>,
): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() })) as
    { type?: string; error?: string; result?: T } | undefined;
  if (!reply) throw new Error('The background did not answer.');
  if (reply.type === 'error') throw new Error(reply.error || 'Something went wrong.');
  return reply.result as T;
}

/** The moves and offers Ava keeps, followed live. */
export function usePlacement(): PlacementState {
  const [state, setState] = useState<PlacementState>(emptyPlacementState());
  useEffect(() => {
    let alive = true;
    const load = () =>
      void placementStorage
        .get()
        .then(next => alive && setState({ ...emptyPlacementState(), ...next }))
        .catch(() => undefined);
    load();
    const off = placementStorage.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
