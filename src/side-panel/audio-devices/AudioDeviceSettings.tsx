import { useCallback, useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { audioDeviceSettingsStore, ttsSettingsStore } from '@extension/storage';
import type { AudioDeviceChoice, AudioDeviceSettingsConfig } from '@extension/storage';
import { devicesOfKind, resolveAudioDevice, fallbackLabel, type AudioDeviceOption } from '@extension/shared';
import type { PanelApi } from '../registry';

const SELECT_CLASS = 'glass w-full rounded-lg px-2 py-1.5 text-[13px] text-foreground outline-none';
const row = 'flex flex-col gap-1.5 px-3 py-2.5';
const SYSTEM_DEFAULT_VALUE = '__system_default__';

/**
 * Settings › Voice devices: which microphone and speaker to use, from the devices connected right now,
 * updated live as they (dis)connect. Only the offscreen document can see device labels (it is the one
 * context with microphone access — see src/offscreen/devices.ts), so the list comes from the background
 * on 'audio_devices_list', not from this page's own `navigator.mediaDevices`. This page still listens for
 * its own `devicechange` event, which fires regardless of where permission was granted, as the cue to ask
 * the background for a fresh (labeled) list.
 */
export default function AudioDeviceSettings({ api }: { api: PanelApi }) {
  const [settings, setSettings] = useState<AudioDeviceSettingsConfig | null>(null);
  const [devices, setDevices] = useState<AudioDeviceOption[]>([]);
  const [systemTts, setSystemTts] = useState(false);

  useEffect(() => {
    const load = () => void audioDeviceSettingsStore.getSettings().then(setSettings);
    load();
    return audioDeviceSettingsStore.subscribe(load);
  }, []);

  useEffect(() => {
    const load = () => void ttsSettingsStore.getSettings().then(value => setSystemTts(value.engine === 'system'));
    load();
    return ttsSettingsStore.subscribe(load);
  }, []);

  const refreshDevices = useCallback(() => {
    api
      .request<{ devices?: AudioDeviceOption[] }>({ type: 'audio_devices_list' })
      .then(reply => setDevices(reply.devices ?? []))
      .catch(() => setDevices([]));
  }, [api]);

  useEffect(() => {
    refreshDevices();
    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
    mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  if (!settings) return null;

  const mics = devicesOfKind(devices, 'audioinput');
  const speakers = devicesOfKind(devices, 'audiooutput');
  const micResolved = resolveAudioDevice(mics, settings.mic);
  const speakerResolved = resolveAudioDevice(speakers, settings.speaker);

  const choose = (kind: 'mic' | 'speaker', list: AudioDeviceOption[], deviceId: string) => {
    const choice: AudioDeviceChoice | null =
      deviceId === SYSTEM_DEFAULT_VALUE
        ? null
        : (() => {
            const device = list.find(item => item.deviceId === deviceId);
            return device ? { deviceId: device.deviceId, label: device.label } : null;
          })();
    void audioDeviceSettingsStore.updateSettings({ [kind]: choice });
  };

  return (
    <>
      <div className={row}>
        <label htmlFor="audio-device-mic" className="text-[13px]">
          {t('audio_device_mic_label')}
        </label>
        <select
          id="audio-device-mic"
          className={SELECT_CLASS}
          value={micResolved.deviceId ?? SYSTEM_DEFAULT_VALUE}
          onChange={event => choose('mic', mics, event.target.value)}>
          <option value={SYSTEM_DEFAULT_VALUE}>{t('audio_device_systemDefault')}</option>
          {mics.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {fallbackLabel(device, index)}
            </option>
          ))}
        </select>
        {!micResolved.connected && (
          <p className="text-muted-foreground text-[11.5px]">{t('audio_device_disconnected')}</p>
        )}
      </div>
      <div className={row}>
        <label htmlFor="audio-device-speaker" className="text-[13px]">
          {t('audio_device_speaker_label')}
        </label>
        <select
          id="audio-device-speaker"
          className={SELECT_CLASS}
          value={speakerResolved.deviceId ?? SYSTEM_DEFAULT_VALUE}
          onChange={event => choose('speaker', speakers, event.target.value)}>
          <option value={SYSTEM_DEFAULT_VALUE}>{t('audio_device_systemDefault')}</option>
          {speakers.map((device, index) => (
            <option key={device.deviceId} value={device.deviceId}>
              {fallbackLabel(device, index)}
            </option>
          ))}
        </select>
        {!speakerResolved.connected && (
          <p className="text-muted-foreground text-[11.5px]">{t('audio_device_disconnected')}</p>
        )}
        {systemTts && (
          <p className="text-muted-foreground text-[11.5px]">{t('audio_device_speaker_systemVoicesNote')}</p>
        )}
      </div>
    </>
  );
}
