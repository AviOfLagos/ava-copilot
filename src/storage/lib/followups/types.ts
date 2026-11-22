// Follow-ups (docs/pm-desk.md, Part 9): what each person said they did, are doing and will do next. One record per
// update: from a call's note, from what Avi reports back ("ada says …" on WhatsApp or in the panel), or typed by hand.

export type PersonUpdateSourceKind = 'meeting' | 'whatsapp' | 'manual';

/** A "did" that matches one of the person's open tasks: offered as "Mark done?", never closed without Avi. */
export interface MarkDoneOffer {
  taskId: string;
  // The words of the "did" that matched, as said
  said: string;
  // Avi's answer: unset until he clicks
  answer?: 'done' | 'no';
  answeredAt?: number;
}

export interface PersonUpdate {
  // 'pu_' + 10 base32 chars (deterministic for a meeting's update, so a note written twice saves it once)
  id: string;
  // Resolved through people.resolve; null while the name is not settled (People asks who it is)
  personId: string | null;
  // The name as said
  name: string;
  workspaceId: string | null;
  // What they said they finished
  did: string[];
  // What they are on now
  doing: string[];
  // What is expected next
  next: string[];
  // ISO date (YYYY-MM-DD, local), worked out in code from byText when one was said
  by?: string;
  byText?: string;
  blockers: string[];
  source: { kind: PersonUpdateSourceKind; id?: string };
  // When it was said: the call's start, the message's time
  at: number;
  // "Did" lines that match an open task of theirs (code, ../../background/followups/match.ts)
  offers?: MarkDoneOffer[];
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 'pu_' + 10 random base32 chars. */
export function newPersonUpdateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `pu_${[...bytes].map(byte => BASE32[byte % 32]).join('')}`;
}

/** The same 'pu_' id for the same parts (a meeting and a name): FNV-1a, two rounds, base32. */
export function personUpdateIdOf(...parts: string[]): string {
  const text = parts.join('|');
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  let bits = BigInt(a) * 0x100000000n + BigInt(b);
  let id = '';
  for (let index = 0; index < 10; index++) {
    id += BASE32[Number(bits & 31n)];
    bits >>= 5n;
  }
  return `pu_${id}`;
}

export const PERSON_UPDATE_ID_PATTERN = /^pu_[a-z2-7]{10}$/;
