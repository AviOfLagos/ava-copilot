import type { AudioDeviceOption } from '@extension/shared';

/**
 * The microphones and speakers connected right now, with labels. Only the offscreen document has
 * microphone access (see src/offscreen/wake.ts, voice.ts), so this is the one place that can read
 * labels at all — `enumerateDevices()` elsewhere in the extension returns them blank. If nothing has
 * requested the microphone yet in this offscreen document's lifetime, the labels start blank too; a
 * short-lived `getUserMedia` primes them, then the stream is dropped at once.
 */
export async function enumerateAudioDevices(): Promise<AudioDeviceOption[]> {
  let found = await navigator.mediaDevices.enumerateDevices();
  const audio = (list: MediaDeviceInfo[]) => list.filter(d => d.kind === 'audioinput' || d.kind === 'audiooutput');
  if (audio(found).some(device => !device.label)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      found = await navigator.mediaDevices.enumerateDevices();
    } catch {
      // No mic to prime labels with; the list below just has unlabeled devices
    }
  }
  return audio(found).map(device => ({
    deviceId: device.deviceId,
    label: device.label,
    kind: device.kind as 'audioinput' | 'audiooutput',
  }));
}
