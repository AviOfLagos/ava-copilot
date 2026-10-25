import { requestMicStream } from '@extension/shared';
import type { EconomyEngines } from '../../background/voice/engines/wire';
import { acquireStt, releaseStt } from '../stt/pool';
import type { SttEngine } from '../stt/engines';
import { AmbientScribe } from './scribe';
import type { PauseReason, ScribeEvent } from './scribe';

/**
 * Holds the microphone for ambient listening and feeds the scribe. Its own stream (beside the wake word's), so
 * either runs without the other. The recogniser is let go while listening is paused, so a conversation that needs
 * a different model can load it; on battery below LOW_BATTERY it switches to the smallest model installed.
 */

const RATE = 16_000;
const LOW_BATTERY = 0.3;
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

type SttChoice = EconomyEngines['stt'];

export interface AmbientConfig {
  stt: SttChoice;
  // The smallest recogniser installed, for when the Mac runs on a low battery; the same as `stt` when there is none
  lowPowerStt: SttChoice;
  offRecord: boolean;
  nameWords: string[];
}

interface BatteryLike extends EventTarget {
  charging: boolean;
  level: number;
}

export class AmbientListener {
  private readonly scribe: AmbientScribe;
  private config: AmbientConfig | null = null;
  private engine: SttEngine | null = null;
  private engineKey = '';
  private acquiring: Promise<void> | null = null;
  private mic: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private input: AudioContext | null = null;
  private micDeviceId: string | null = null;
  private battery: BatteryLike | null = null;
  private readonly onBattery = () => void this.ensureEngine();

  constructor(emit: (event: ScribeEvent) => void) {
    this.scribe = new AmbientScribe({
      emit,
      transcribe: async audio => {
        await this.acquiring;
        if (!this.engine) throw new Error('No recogniser is loaded');
        return this.engine.transcribe(audio);
      },
    });
  }

  get running(): boolean {
    return this.input !== null;
  }

  get offRecord(): boolean {
    return this.scribe.isOffRecord;
  }

  /** Starts listening, or applies new settings to a listener already running. */
  async start(config: AmbientConfig, micDeviceId: string | null): Promise<void> {
    this.config = config;
    this.scribe.configure({ offRecord: config.offRecord, nameWords: config.nameWords });
    if (this.input) {
      await this.ensureEngine();
      return;
    }
    this.micDeviceId = micDeviceId;
    try {
      await this.watchBattery();
      await this.ensureEngine();
      this.mic = await requestMicStream(navigator.mediaDevices, micDeviceId, MIC_CONSTRAINTS);
      this.input = new AudioContext({ sampleRate: RATE });
      await this.input.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
      const node = new AudioWorkletNode(this.input, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = event => this.scribe.push(event.data as Float32Array);
      this.node = node;
      this.micSource = this.input.createMediaStreamSource(this.mic);
      this.micSource.connect(node);
      const mute = this.input.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(this.input.destination);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.battery?.removeEventListener('levelchange', this.onBattery);
    this.battery?.removeEventListener('chargingchange', this.onBattery);
    this.battery = null;
    this.mic?.getTracks().forEach(track => track.stop());
    this.mic = null;
    this.micSource = null;
    this.node = null;
    void this.input?.close().catch(() => {});
    this.input = null;
    this.letGoOfEngine();
    this.config = null;
  }

  pause(reason: PauseReason): void {
    const wasPaused = this.scribe.paused;
    this.scribe.pause(reason);
    if (!wasPaused) this.letGoOfEngine();
  }

  resume(reason: PauseReason): void {
    this.scribe.resume(reason);
    if (!this.scribe.paused && this.input) void this.ensureEngine();
  }

  async switchMic(deviceId: string | null): Promise<void> {
    if (deviceId === this.micDeviceId) return;
    this.micDeviceId = deviceId;
    if (!this.input || !this.node) return;
    const next = await requestMicStream(navigator.mediaDevices, deviceId, MIC_CONSTRAINTS);
    this.micSource?.disconnect();
    this.mic?.getTracks().forEach(track => track.stop());
    this.mic = next;
    this.micSource = this.input.createMediaStreamSource(next);
    this.micSource.connect(this.node);
  }

  private lowPower(): boolean {
    return !!this.battery && !this.battery.charging && this.battery.level < LOW_BATTERY;
  }

  private async watchBattery(): Promise<void> {
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
    if (!getBattery || this.battery) return;
    this.battery = await getBattery.call(navigator).catch(() => null);
    this.battery?.addEventListener('levelchange', this.onBattery);
    this.battery?.addEventListener('chargingchange', this.onBattery);
  }

  /** Loads the recogniser the settings and the battery call for, replacing another one this holds. */
  private ensureEngine(): Promise<void> {
    const config = this.config;
    if (!config || this.scribe.paused) return Promise.resolve();
    const choice = this.lowPower() ? config.lowPowerStt : config.stt;
    const key = `${choice.engine}:${choice.model ?? ''}:${choice.webgpu ? 'gpu' : 'cpu'}`;
    if (this.engine && key === this.engineKey) return Promise.resolve();
    // A load that failed before does not block the next one
    const previous = (this.acquiring ?? Promise.resolve()).catch(() => {});
    this.acquiring = previous.then(async () => {
      if (this.engine && key === this.engineKey) return;
      this.letGoOfEngine();
      const engine = await acquireStt(choice);
      // Paused or stopped while it loaded: give it straight back
      if (this.scribe.paused || !this.config) {
        releaseStt();
        return;
      }
      this.engine = engine;
      this.engineKey = key;
    });
    return this.acquiring;
  }

  private letGoOfEngine(): void {
    if (!this.engine) return;
    this.engine = null;
    this.engineKey = '';
    releaseStt();
  }
}
