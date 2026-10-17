import { useSyncExternalStore } from 'react';
import type { VoiceModelComponentId } from '@extension/shared';
import type { PanelApi } from '../registry';

/**
 * Before Talk, dictation or the wake word starts: whether the local models it needs are here, and if not, the
 * download card instead of an error. `ensureVoiceModels` resolves true when the feature can start (nothing was
 * missing, or the download finished), false when the user said not now and it cannot run without them.
 */

export type VoiceFeature = 'talk' | 'dictation' | 'wake';
// Where the card shows: at the top of the panel, or inside the first-run setup (a dialog over the panel)
export type CardPlacement = 'panel' | 'onboarding';

export interface GateRequest {
  feature: VoiceFeature;
  required: VoiceModelComponentId[];
  optional: VoiceModelComponentId[];
  placement: CardPlacement;
  request: PanelApi['request'];
  resolve: (ok: boolean) => void;
}

let current: GateRequest | null = null;
const listeners = new Set<() => void>();
// Optional models the user said not now to, in this panel: not offered again until it is opened again
const declined = new Set<VoiceModelComponentId>();

function set(next: GateRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function gateRequest(): GateRequest | null {
  return current;
}

export function useGateRequest(): GateRequest | null {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, gateRequest);
}

export async function ensureVoiceModels(
  feature: VoiceFeature,
  request: PanelApi['request'],
  placement: CardPlacement = 'panel',
): Promise<boolean> {
  let needed: { required?: VoiceModelComponentId[]; optional?: VoiceModelComponentId[] };
  try {
    needed = await request({ type: 'voice_models_needed', feature });
  } catch {
    // Cannot tell: the feature starts and says what is wrong itself
    return true;
  }
  const required = needed.required ?? [];
  const optional = (needed.optional ?? []).filter(id => !declined.has(id));
  if (!required.length && !optional.length) return true;
  return new Promise<boolean>(resolve => {
    current?.resolve(false);
    set({ feature, required, optional, placement, request, resolve });
  });
}

/** The download finished: the feature goes on. */
export function gateReady(): void {
  const request = current;
  set(null);
  request?.resolve(true);
}

/** Not now: the feature goes on only when what is missing was optional. */
export function gateDecline(): void {
  const request = current;
  if (!request) return;
  for (const id of request.optional) declined.add(id);
  set(null);
  request.resolve(request.required.length === 0);
}

/** The download was stopped: the feature does not start now, and the card is offered again next time. */
export function gateCancel(): void {
  const request = current;
  set(null);
  request?.resolve(false);
}
