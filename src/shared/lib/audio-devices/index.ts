/**
 * Picking a microphone or speaker that stays picked across sessions and across the device
 * (dis)connecting, even though a browser reassigns `deviceId` on every permission grant/session —
 * only the label is stable. Kept here, framework-free, so it is cheap to unit test (see
 * `__tests__/index.test.ts`) and shared by the settings UI and every capture/playback site
 * (`src/offscreen/wake.ts`, `voice.ts`, `recorder.ts`, `tts.ts`, `tts-local/player.ts`,
 * `src/side-panel/hooks/useSpeechInput.ts`).
 */

/** One entry from `navigator.mediaDevices.enumerateDevices()`, trimmed to what this module needs. */
export interface AudioDeviceOption {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

/** What is persisted for a chosen device: `null` means "System default". */
export interface AudioDeviceChoice {
  deviceId: string;
  label: string;
}

export interface ResolvedAudioDevice {
  // `null` asks getUserMedia/setSinkId for the system default (no `deviceId` constraint / '' sink)
  deviceId: string | null;
  // The choice was the system default, or a specific device that is currently present
  connected: boolean;
}

const SYSTEM_DEFAULT: ResolvedAudioDevice = { deviceId: null, connected: true };

/**
 * Resolves a stored choice against the devices seen right now. Matches by `deviceId` first (the
 * common case within one permission session), falling back to the label (deviceIds are reassigned
 * between sessions, but a real device's label does not change). No match at all means the device is
 * disconnected: the caller falls back to the system default and may say so in the UI.
 */
export function resolveAudioDevice(
  devices: AudioDeviceOption[],
  choice: AudioDeviceChoice | null,
): ResolvedAudioDevice {
  if (!choice) return SYSTEM_DEFAULT;
  const byId = devices.find(device => device.deviceId === choice.deviceId);
  if (byId) return { deviceId: byId.deviceId, connected: true };
  const byLabel = choice.label ? devices.find(device => device.label === choice.label) : undefined;
  if (byLabel) return { deviceId: byLabel.deviceId, connected: true };
  return { deviceId: null, connected: false };
}

export function devicesOfKind(devices: AudioDeviceOption[], kind: AudioDeviceOption['kind']): AudioDeviceOption[] {
  return devices.filter(device => device.kind === kind);
}

/** A display label for a device whose label Chrome has not filled in (no permission yet, or a quirky device). */
export function fallbackLabel(device: AudioDeviceOption, index: number): string {
  if (device.label) return device.label;
  return device.kind === 'audioinput' ? `Microphone ${index + 1}` : `Speaker ${index + 1}`;
}

/**
 * `getUserMedia({ audio: { deviceId: { exact } } })` constraints for a chosen device id: no
 * `deviceId` at all for the system default (`null`), so the browser is free to pick and the
 * constraint object cannot itself cause an OverconstrainedError.
 */
export function micConstraints(deviceId: string | null, base: MediaTrackConstraints = {}): MediaTrackConstraints {
  if (!deviceId) return base;
  return { ...base, deviceId: { exact: deviceId } };
}

/**
 * Opens the microphone with a chosen device, falling back to the system default when that device is
 * no longer there (OverconstrainedError: it matched nothing; NotFoundError: Chrome removed it from
 * the device list entirely). Every capture site uses this so a stale choice never breaks capture.
 */
export async function requestMicStream(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>,
  deviceId: string | null,
  base: MediaTrackConstraints = {},
): Promise<MediaStream> {
  try {
    return await mediaDevices.getUserMedia({ audio: micConstraints(deviceId, base) });
  } catch (error) {
    const isGoneDevice =
      deviceId != null &&
      error instanceof DOMException &&
      (error.name === 'OverconstrainedError' || error.name === 'NotFoundError');
    if (!isGoneDevice) throw error;
    return mediaDevices.getUserMedia({ audio: base });
  }
}

interface SinkCapable {
  setSinkId?: (sinkId: string) => Promise<void>;
}

/**
 * Routes playback to a chosen speaker, on whichever of `HTMLMediaElement.setSinkId` or (newer,
 * Chromium) `AudioContext.setSinkId` the target has (neither is in TypeScript's DOM lib yet, hence
 * the cast through `unknown`). `deviceId: null` asks for the system default (`''`). Silently does
 * nothing where the API is unsupported, which is the correct behavior: there is nothing to switch
 * to, and playback keeps using the system default it already had.
 */
export async function setAudioSinkId(target: object, deviceId: string | null): Promise<void> {
  const sinkCapable = target as unknown as SinkCapable;
  if (typeof sinkCapable.setSinkId !== 'function') return;
  try {
    await sinkCapable.setSinkId(deviceId ?? '');
  } catch {
    // The device may have just disconnected, or the API may refuse a stale id; playback keeps
    // using whatever sink it already had rather than breaking audio over this.
  }
}
