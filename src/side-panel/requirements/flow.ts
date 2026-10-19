/**
 * Install before use: one flow for everything a setting can need installed first (a voice model, the wake
 * word's model, an Ollama model, the embedding model, Nex Brain, Obsidian access). A setting calls
 * `choose(requirement, save)`: when the requirement is ready the choice is saved at once; when not, the flow asks
 * (the card shows "Needs KittenTTS, 28 MB — Install / Cancel"), and the choice is saved only after the install
 * finished and the requirement reads as ready. Cancel at any point leaves the old choice. Things that cannot be
 * installed from here (a flag, a Mac app) show their steps and a "Check again" instead of Install.
 */

export interface InstallProgress {
  received: number;
  total: number;
  // What the installer says it is doing ("pulling manifest", "verifying")
  status?: string;
}

export interface Requirement {
  id: string;
  // What is needed, as the user knows it ("KittenTTS", "nomic-embed-text")
  label: string;
  sizeBytes?: number;
  isReady: () => Promise<boolean>;
  // Installs it; rejects when it fails or `signal` aborts. Absent when the user has to do it (see `steps`)
  install?: (onProgress: (progress: InstallProgress) => void, signal: AbortSignal) => Promise<void>;
  // What the user does when it cannot be installed from here
  steps?: string[];
  link?: { url: string; label: string };
}

export type FlowPhase = 'idle' | 'checking' | 'asking' | 'installing' | 'failed';

export interface FlowState {
  phase: FlowPhase;
  requirement: Requirement | null;
  progress: InstallProgress | null;
  error: string | null;
}

export const IDLE_FLOW: FlowState = { phase: 'idle', requirement: null, progress: null, error: null };

export interface RequirementFlow {
  getState: () => FlowState;
  subscribe: (listener: () => void) => () => void;
  // Resolves true once the choice was saved, false when the user cancelled (or another choice replaced it)
  choose: (requirement: Requirement, save: () => Promise<void> | void) => Promise<boolean>;
  install: () => Promise<void>;
  // For steps the user follows elsewhere: saves the choice once the requirement reads as ready
  recheck: () => Promise<void>;
  cancel: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRequirementFlow(messages: { notReady: string } = { notReady: 'It is not ready yet.' }) {
  let state: FlowState = IDLE_FLOW;
  let pending: { requirement: Requirement; save: () => Promise<void> | void; resolve: (ok: boolean) => void } | null =
    null;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();

  const set = (next: FlowState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const finish = (ok: boolean) => {
    const done = pending;
    pending = null;
    controller = null;
    set(IDLE_FLOW);
    done?.resolve(ok);
  };

  const saveNow = async () => {
    const current = pending;
    if (!current) return;
    try {
      await current.save();
      finish(true);
    } catch (error) {
      set({ ...state, phase: 'failed', error: message(error) });
    }
  };

  const flow: RequirementFlow = {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    choose: (requirement, save) => {
      // A choice made while another was waiting replaces it; the earlier one is not saved
      if (pending) {
        controller?.abort();
        const earlier = pending;
        pending = null;
        earlier.resolve(false);
      }
      return new Promise<boolean>(resolve => {
        const mine = { requirement, save, resolve };
        pending = mine;
        set({ phase: 'checking', requirement, progress: null, error: null });
        void requirement
          .isReady()
          .catch(() => false)
          .then(async ready => {
            if (pending !== mine) return;
            if (ready) await saveNow();
            else set({ phase: 'asking', requirement, progress: null, error: null });
          });
      });
    },
    install: async () => {
      const current = pending;
      if (!current?.requirement.install || state.phase === 'installing') return;
      const mine = new AbortController();
      controller = mine;
      set({ phase: 'installing', requirement: current.requirement, progress: null, error: null });
      try {
        await current.requirement.install(progress => {
          if (pending === current && !mine.signal.aborted) set({ ...state, progress });
        }, mine.signal);
        if (pending !== current || mine.signal.aborted) return;
        if (!(await current.requirement.isReady().catch(() => false))) throw new Error(messages.notReady);
        if (pending !== current) return;
        await saveNow();
      } catch (error) {
        if (pending !== current || mine.signal.aborted) return;
        set({ phase: 'failed', requirement: current.requirement, progress: null, error: message(error) });
      }
    },
    recheck: async () => {
      const current = pending;
      if (!current) return;
      set({ ...state, phase: 'checking', error: null });
      const ready = await current.requirement.isReady().catch(() => false);
      if (pending !== current) return;
      if (ready) await saveNow();
      else set({ phase: 'failed', requirement: current.requirement, progress: null, error: messages.notReady });
    },
    cancel: () => {
      controller?.abort();
      finish(false);
    },
  };
  return flow;
}
