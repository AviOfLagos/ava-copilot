/**
 * What Ava hears while she only listens (docs/ambient-plan.md, A1): continuous talk cut into sessions, and the
 * words of each utterance. Written on the device by the local recogniser; raw audio is never kept.
 */

// Who said it. Everything is 'unknown' until voiceprints (A2) tell Avi's voice from others and from media
export type AmbientSpeaker = 'unknown' | 'me' | 'media' | `other:${number}`;

export interface AmbientSession {
  id: string;
  startedAt: number;
  // The end of its last utterance; a session with no utterance for SESSION_GAP_MS is over
  endedAt: number;
  utteranceCount: number;
  // Filed into a workspace by the scribe (A3); null until then
  workspaceId: string | null;
}

export interface AmbientUtterance {
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt: number;
  speaker: AmbientSpeaker;
  text: string;
}
