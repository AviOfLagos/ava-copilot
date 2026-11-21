import type { VocabEntry } from '@extension/storage';

// Every name here is made up, except "Ellum", the owner's own product that the spec uses as its example
let n = 0;
export function entry(write: string, heardAs: string[] = [], extra: Partial<VocabEntry> = {}): VocabEntry {
  n += 1;
  return {
    id: `e${n}`,
    write,
    heardAs,
    kind: 'name',
    workspaceId: null,
    learnedFrom: 'avi',
    uses: 0,
    createdAt: n,
    ...extra,
  };
}

export const ENTRIES = (): VocabEntry[] => [
  entry('Ellum', ['Illum', 'L.M.'], { kind: 'product' }),
  entry('Quillon', ['Quill on', 'Killon']),
  entry('Zorvane', ['Zor Vane'], { kind: 'product' }),
  entry('Brindle Labs', ['Brindle Lab'], { kind: 'name' }),
  entry('Haldane', [], { kind: 'person' }),
  entry('Pemberly', [], { kind: 'person' }),
  entry('Vextra', ['Vex Tra'], { kind: 'product' }),
];
