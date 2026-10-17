/**
 * Whose turn it is in a Live voice conversation, so the copilot never talks over the user. A system notice
 * ("the task finished") or a line of tab context is client content, and client content cuts in: sent while the
 * user is mid-sentence it ends their turn, and sent while the copilot's answer still plays it stops the answer.
 * So those wait until the floor is free: the user is not speaking, their last words have had an answer (or long
 * enough to get one), no tool is running, and the copilot's voice has finished playing, not merely been sent.
 */

// After the user stops, how long the server may take to answer before the floor counts as free again (it may
// have decided the sound was not speech at all)
export const REPLY_WAIT_MS = 1500;

export class TurnTaking {
  private userSpeaking = false;
  private awaitingReply = false;
  private awaitingSince = 0;
  private modelTalking = false;
  private tools = 0;
  // When the copilot's queued voice stops being audible, on the performance.now() clock
  private playbackEnd = 0;

  /** The user started talking (our speech gate opened). */
  userStarted(): void {
    this.userSpeaking = true;
    this.awaitingReply = true;
  }

  /** The user stopped talking (our speech gate closed). */
  userEnded(now: number): void {
    this.userSpeaking = false;
    this.awaitingSince = now;
  }

  /** The model's answer started: audio, or a tool call. */
  modelStarted(): void {
    this.modelTalking = true;
    this.awaitingReply = false;
  }

  /** The model finished its turn (turnComplete), or was cut off. */
  modelEnded(): void {
    this.modelTalking = false;
    this.awaitingReply = false;
  }

  /** The user talked over the copilot: its voice stops now, and their words want an answer. */
  interrupted(now: number): void {
    this.modelTalking = false;
    this.playbackEnd = now;
    this.awaitingReply = true;
    this.awaitingSince = now;
  }

  toolStarted(): void {
    this.tools++;
    this.awaitingReply = false;
  }

  toolEnded(): void {
    this.tools = Math.max(0, this.tools - 1);
  }

  /** The copilot's voice is queued until this moment (performance.now() milliseconds). */
  playUntil(end: number): void {
    this.playbackEnd = Math.max(this.playbackEnd, end);
  }

  stopPlayback(now: number): void {
    this.playbackEnd = now;
  }

  /** The copilot's voice can be heard now. */
  playing(now: number): boolean {
    return now < this.playbackEnd;
  }

  /** The copilot is speaking, as the user experiences it: its turn is on, or its voice still plays. */
  speaking(now: number): boolean {
    return this.modelTalking || this.playing(now);
  }

  /** Whether a notice or context line may be sent now without cutting anyone off. */
  floorFree(now: number): boolean {
    if (this.userSpeaking || this.tools > 0 || this.speaking(now)) return false;
    return !(this.awaitingReply && now - this.awaitingSince < REPLY_WAIT_MS);
  }
}
