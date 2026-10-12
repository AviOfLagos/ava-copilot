// What a narration line's audio depends on: the words read, the voice and the speed. Shared by scripts/narrate.mjs
// (which names the files after it) and the site (which warns at build time when a line's audio is out of date).
import { createHash } from 'node:crypto';

/**
 * @param {{ text: string, say?: string }} line
 * @param {string} voice
 * @param {number} speed
 * @returns {string}
 */
export function lineHash(line, voice, speed) {
  return createHash('sha256')
    .update(JSON.stringify({ say: line.say ?? line.text, voice, speed }))
    .digest('hex')
    .slice(0, 10);
}
