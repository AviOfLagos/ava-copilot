import { describe, expect, it } from 'vitest';
import { ensureVoiceModels, gateDecline, gateReady, gateRequest } from '../gate';

const answering =
  (reply: Record<string, unknown>) =>
  async <T>() =>
    reply as T;

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('ensureVoiceModels', () => {
  it('lets the feature start at once when nothing is missing, or when the background cannot tell', async () => {
    expect(await ensureVoiceModels('talk', answering({ required: [], optional: [] }))).toBe(true);
    expect(
      await ensureVoiceModels('talk', async () => {
        throw new Error('no answer');
      }),
    ).toBe(true);
    expect(gateRequest()).toBeNull();
  });

  it('shows the card and starts the feature once the download is done', async () => {
    const started = ensureVoiceModels('talk', answering({ required: ['moonshine-tiny'], optional: ['kitten'] }));
    await settle();
    expect(gateRequest()).toMatchObject({ feature: 'talk', required: ['moonshine-tiny'], optional: ['kitten'] });
    gateReady();
    expect(await started).toBe(true);
    expect(gateRequest()).toBeNull();
  });

  it('does not start when the user says not now to what it cannot run without', async () => {
    const started = ensureVoiceModels('wake', answering({ required: ['vosk'], optional: [] }), 'onboarding');
    await settle();
    expect(gateRequest()?.placement).toBe('onboarding');
    gateDecline();
    expect(await started).toBe(false);
  });

  it('starts without a better voice that was only optional, and does not offer it again', async () => {
    const started = ensureVoiceModels('talk', answering({ required: [], optional: ['kitten'] }));
    await settle();
    gateDecline();
    expect(await started).toBe(true);
    expect(await ensureVoiceModels('talk', answering({ required: [], optional: ['kitten'] }))).toBe(true);
  });
});
