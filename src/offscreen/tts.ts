import { setAudioSinkId } from '@extension/shared';

export interface TtsPlayerCallbacks {
  onEnded: () => void;
  onError: (message: string) => void;
}

/**
 * Plays audio the background already turned into speech (the Gemini engine). System voices never
 * reach here - they speak straight from the background through `chrome.tts`. One `<audio>` element,
 * one clip at a time; a `data:` URL needs no network fetch, which the offscreen document has no
 * reason to make.
 */
export class TtsPlayer {
  private readonly audio: HTMLAudioElement;
  private stopping = false;

  constructor(private readonly callbacks: TtsPlayerCallbacks) {
    this.audio = new Audio();
    this.audio.addEventListener('ended', () => this.callbacks.onEnded());
    this.audio.addEventListener('error', () => {
      if (this.stopping) return;
      this.callbacks.onError(this.audio.error?.message || 'Playback failed');
    });
  }

  /** Switches the speaker this plays through (Settings › Voice devices). */
  setOutputDevice(deviceId: string | null): void {
    void setAudioSinkId(this.audio, deviceId);
  }

  play(dataUrl: string): void {
    this.stopping = false;
    this.audio.pause();
    this.audio.src = dataUrl;
    this.audio.currentTime = 0;
    void this.audio.play().catch(error => {
      if (!this.stopping) this.callbacks.onError(String(error));
    });
  }

  stop(): void {
    this.stopping = true;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }
}
