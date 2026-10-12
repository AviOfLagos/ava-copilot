/**
 * Idle end for every voice conversation (Live or economy): one where nothing was said or done for the minutes set
 * in Settings › Voice engines, with no task running or waiting for the user, ends by itself. A conversation "Hey
 * Ava" started keeps its own, shorter idle end in the voice manager.
 */

export interface IdleState {
  running: boolean;
  // 0 never ends a conversation for being quiet
  idleMinutes: number;
  lastActivity: number;
  now: number;
  // A task is running or waiting for the user's click: it will be announced, so the conversation stays
  tasksBusy: boolean;
}

export function shouldEndIdle(state: IdleState): boolean {
  if (!state.running || state.idleMinutes <= 0 || state.tasksBusy) return false;
  return state.now - state.lastActivity >= state.idleMinutes * 60_000;
}

/** Messages from the offscreen voice session that show the conversation is alive. */
export function isVoiceActivity(message: { type?: unknown; status?: unknown } | null | undefined): boolean {
  switch (message?.type) {
    case 'voice_turn':
    case 'voice_tool':
    case 'voice_engine_turn':
      return true;
    case 'voice_status':
      return message.status !== 'off';
    default:
      return false;
  }
}
