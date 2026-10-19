import { describe, expect, it } from 'vitest';
import { missingVoiceFiles } from '../missing';

describe('missingVoiceFiles', () => {
  it('knows an on-device voice whose files are not there', () => {
    expect(
      missingVoiceFiles(
        new Error(
          '`local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at voice/kokoro',
        ),
      ),
    ).toBe(true);
    expect(missingVoiceFiles('Failed to load the model')).toBe(true);
  });

  it('leaves other failures alone, a stop included', () => {
    expect(missingVoiceFiles(new Error('Speech was stopped'))).toBe(false);
    expect(missingVoiceFiles(new DOMException('The operation was aborted.', 'AbortError'))).toBe(false);
  });
});
