import { describe, expect, it } from 'vitest';
// The setup scripts stay self-contained (install.sh --with-voices fetches each on its own), so the extension's list
// is checked against theirs instead of shared with them
import { COMPONENTS } from '../../../../../scripts/voice-models-setup.mjs';
import { SOURCES } from '../../../../../scripts/wake-word-setup.mjs';
import { downloadBytes, VOICE_MODEL_CATALOG } from '../catalog';

type ScriptFile = [string, string, number, string];

describe('VOICE_MODEL_CATALOG', () => {
  it('downloads exactly the files, sizes and sums the voice models script pins', () => {
    for (const [id, component] of Object.entries(
      COMPONENTS as unknown as Record<string, { files: Record<string, ScriptFile> }>,
    )) {
      const expected = Object.entries(component.files).map(([path, [repoAtRevision, source, bytes, sha256]]) => {
        const [repo, revision] = repoAtRevision.split('@');
        return { path, url: `https://huggingface.co/${repo}/resolve/${revision}/${source}`, bytes, sha256 };
      });
      expect(VOICE_MODEL_CATALOG[id as keyof typeof VOICE_MODEL_CATALOG].files).toEqual(expected);
    }
  });

  it('downloads the Vosk model the wake word script pins', () => {
    const [file] = VOICE_MODEL_CATALOG.vosk.files;
    expect(file.url).toBe(SOURCES.model.url);
    expect(file.sha256).toBe(SOURCES.model.sha256);
  });

  it('has the smallest useful set small: about 60 MB for voice, 41 MB for the wake word', () => {
    const voice = downloadBytes(VOICE_MODEL_CATALOG['moonshine-tiny']) + downloadBytes(VOICE_MODEL_CATALOG.kitten);
    expect(Math.round(voice / 1e6)).toBe(60);
    expect(Math.round(downloadBytes(VOICE_MODEL_CATALOG.vosk) / 1e6)).toBe(41);
  });
});
