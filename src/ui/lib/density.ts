/**
 * Tailwind's spacing scale with the person's density folded in: every step is 0.25rem × its number × --density
 * (1 unless the page sets it). Padding, margins, gaps and the h-/w-/size- steps follow it, so "compact" and
 * "roomy" change a whole page at once. Fixed pixel values (`h-[52px]`) stay as they are.
 */
const STEPS = [
  0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72,
  80, 96,
];

export const densitySpacing: Record<string, string> = Object.fromEntries([
  ['0', '0px'],
  ['px', '1px'],
  ...STEPS.map(step => [String(step), `calc(${step * 0.25}rem * var(--density, 1))`]),
]);
