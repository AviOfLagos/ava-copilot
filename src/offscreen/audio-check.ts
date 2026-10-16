import { requestMicStream, setAudioSinkId } from '@extension/shared';

/**
 * check_audio's measuring, in the one document with microphone access: the input level of the chosen microphone
 * over about two seconds, and a short tone on the chosen speaker. Levels only; no audio is kept or sent anywhere.
 */

const SLICE_MS = 100;

export async function measureMic(
  deviceId: string | null,
  durationMs = 2000,
): Promise<{ ok: boolean; levels: number[]; label?: string; error?: string; denied?: boolean }> {
  let stream: MediaStream;
  try {
    // No echo cancellation or noise suppression: they would hide a quiet but working microphone
    stream = await requestMicStream(navigator.mediaDevices, deviceId, {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  } catch (error) {
    const denied = error instanceof DOMException && error.name === 'NotAllowedError';
    return { ok: false, levels: [], denied, error: error instanceof Error ? error.message : String(error) };
  }
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const levels: number[] = [];
    const slices = Math.max(1, Math.round(durationMs / SLICE_MS));
    for (let i = 0; i < slices; i++) {
      await new Promise(resolve => setTimeout(resolve, SLICE_MS));
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      levels.push(Math.sqrt(sum / samples.length));
    }
    return { ok: true, levels, label: stream.getAudioTracks()[0]?.label };
  } finally {
    stream.getTracks().forEach(track => track.stop());
    void context.close();
  }
}

/** A soft two-note tone, about 0.7 s, on the chosen speaker. */
export async function playTestTone(deviceId: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const context = new AudioContext();
    await setAudioSinkId(context, deviceId);
    const gain = context.createGain();
    gain.connect(context.destination);
    const start = context.currentTime + 0.05;
    for (const [i, frequency] of [523.25, 784].entries()) {
      const tone = context.createOscillator();
      tone.frequency.value = frequency;
      tone.connect(gain);
      tone.start(start + i * 0.35);
      tone.stop(start + i * 0.35 + 0.3);
    }
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.03);
    gain.gain.setValueAtTime(0.2, start + 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
    setTimeout(() => void context.close(), 1200);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
