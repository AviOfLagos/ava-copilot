// Replayed calls for the spoken-task tests (docs/pm-desk.md, Part 6). Made-up people. Each caption reading is what
// the meeting page sends once a caption block has stood unchanged for 1.5 s (`watchCaptions`): the block's key, its
// whole words, the speaker shown, and whether the page marked the block as the user's own. Microphone readings are
// what the local recogniser wrote for one utterance of the separate command stream.

export interface CaptionReading {
  // ms after the start of the replay
  t: number;
  key: number;
  speaker: string;
  self: boolean;
  whole: string;
  settled?: boolean;
}

export interface MicReading {
  t: number;
  // how long the utterance was
  ms: number;
  text: string;
}

const COMMAND = 'Ava, note a task for Ada: send the deck by Friday.';

export const CAPTIONS = {
  // Avi says it; Meet marks his line as his own and labels it "You"
  avi: [{ t: 0, key: 1, speaker: 'You', self: true, whole: COMMAND }],
  // Another speaker says the same words
  otherSpeaker: [{ t: 0, key: 2, speaker: 'Ben Okafor', self: false, whole: COMMAND }],
  // A guest who named themselves "You": same label as Avi's own lines, no mark
  guestYou: [{ t: 0, key: 3, speaker: 'You', self: false, whole: COMMAND }],
  // A guest who named themselves "Avi"
  guestAvi: [{ t: 0, key: 4, speaker: 'Avi', self: false, whole: COMMAND }],
  // Meet rewrites Avi's line three times after it first settled: a misheard name, punctuation, a word added
  rewrittenThreeTimes: [
    { t: 0, key: 5, speaker: 'You', self: true, whole: 'Ava note a task for Eda send the deck' },
    { t: 1800, key: 5, speaker: 'You', self: true, whole: 'Ava, note a task for Ada: send the deck.' },
    { t: 3600, key: 5, speaker: 'You', self: true, whole: 'Ava, note a task for Ada: send the deck by Friday.' },
  ],
  // The command, then a follow-on sentence in the same caption block
  followOn: [
    { t: 0, key: 6, speaker: 'You', self: true, whole: COMMAND },
    { t: 2500, key: 6, speaker: 'You', self: true, whole: `${COMMAND} Also add the pricing slide.` },
  ],
  // A second command starts a new task; its "and…" goes to the new one
  secondCommand: [
    { t: 0, key: 7, speaker: 'You', self: true, whole: COMMAND },
    { t: 3000, key: 8, speaker: 'You', self: true, whole: 'Ava, note a task for Ben: book the venue.' },
    {
      t: 5000,
      key: 8,
      speaker: 'You',
      self: true,
      whole: 'Ava, note a task for Ben: book the venue. And confirm catering.',
    },
  ],
  // Another sentence, then a pause longer than four seconds: the task is closed when "also" comes
  closedAfterPause: [
    { t: 0, key: 9, speaker: 'You', self: true, whole: COMMAND },
    { t: 2000, key: 9, speaker: 'You', self: true, whole: `${COMMAND} Okay, next topic.` },
    { t: 8000, key: 10, speaker: 'You', self: true, whole: 'Also add the pricing slide.' },
  ],
  // An addition after the two minutes are up
  tooLate: [
    { t: 0, key: 11, speaker: 'You', self: true, whole: COMMAND },
    { t: 125_000, key: 12, speaker: 'You', self: true, whole: 'Also add the pricing slide.' },
  ],
  // The command's words in the next sentence
  wordsNext: [
    { t: 0, key: 13, speaker: 'You', self: true, whole: 'Ava, note a task for Ada.' },
    { t: 2000, key: 13, speaker: 'You', self: true, whole: 'Ava, note a task for Ada. Send the deck by Friday.' },
  ],
  // A name nobody knows yet
  unknownName: [{ t: 0, key: 14, speaker: 'You', self: true, whole: 'Ava, note a task for Zubi: check the invoices.' }],
  // Meet drops the line's oldest words as it grows: the cut-off start is not a new sentence
  trimmed: [
    { t: 0, key: 15, speaker: 'You', self: true, whole: `${COMMAND} Also add the pricing slide.` },
    { t: 2000, key: 15, speaker: 'You', self: true, whole: 'the deck by Friday. Also add the pricing slide.' },
  ],
  // A long turn still going on: only its finished sentences count, and the command counts once it is settled
  longTurn: [
    { t: 0, key: 16, speaker: 'You', self: true, whole: `${COMMAND} Also add the`, settled: false },
    { t: 1600, key: 16, speaker: 'You', self: true, whole: `${COMMAND} Also add the pricing slide.` },
  ],
  // Two commands in a row in one block, differing in one name: two tasks, never a "rewrite" of the first
  twoInOneBlock: [
    { t: 0, key: 17, speaker: 'You', self: true, whole: 'Ava, note a task for Ada: send the deck.' },
    {
      t: 2500,
      key: 17,
      speaker: 'You',
      self: true,
      whole: 'Ava, note a task for Ada: send the deck. Ava, note a task for Ben: send the deck.',
    },
  ],
  // Two different "also…" lines: both are kept
  twoAdditions: [
    { t: 0, key: 18, speaker: 'You', self: true, whole: COMMAND },
    { t: 2000, key: 18, speaker: 'You', self: true, whole: `${COMMAND} Also add the pricing slide.` },
    {
      t: 4000,
      key: 18,
      speaker: 'You',
      self: true,
      whole: `${COMMAND} Also add the pricing slide. Also add the logo slide.`,
    },
  ],
  // A command with no words, then Meet rewrites the same line with its words; the next sentence is not a task
  pendingRewritten: [
    { t: 0, key: 19, speaker: 'You', self: true, whole: 'Ava, note a task for Ada.' },
    { t: 1800, key: 19, speaker: 'You', self: true, whole: 'Ava, note a task for Ada send the deck.' },
    { t: 3600, key: 19, speaker: 'You', self: true, whole: 'Ava, note a task for Ada send the deck. Okay, moving on.' },
  ],
  // The same words for Ada, then for Avi himself
  forMeAfterAda: [
    { t: 0, key: 20, speaker: 'You', self: true, whole: 'Ava, note a task for Ada: send the deck.' },
    { t: 3000, key: 21, speaker: 'You', self: true, whole: 'Ava, note a task for me: send the deck.' },
  ],
} satisfies Record<string, CaptionReading[]>;

export const MIC = {
  avi: [{ t: 0, ms: 2500, text: 'Ava, note a task for Ada, send the deck by Friday.' }],
} satisfies Record<string, MicReading[]>;
