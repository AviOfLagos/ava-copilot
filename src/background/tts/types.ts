/** What any engine needs to speak a line of text. */
export interface SpeakOptions {
  voice?: string;
  rate?: number;
}

/** The one shape both engines offer, so the rest of the background never picks between them by hand. */
export interface TtsEngine {
  speak(text: string, options?: SpeakOptions): Promise<void>;
  stop(): Promise<void>;
  speaking(): Promise<boolean>;
}
