/**
 * What runs inside Ava's own meeting browser (never the user's): the microphone stand-in, installed before any
 * page script, and the expressions that read and press Meet's controls. Each is plain source text, sent over the
 * debugging pipe; none may use anything from this file at run time.
 *
 * Meet's controls are found by their accessible names and visible words, in English. Meet changes its page now
 * and then; when it does, these are the lines to update, and a join that cannot find its button fails with a
 * reason rather than guessing.
 */

/**
 * Replaces navigator.mediaDevices.getUserMedia in every frame of the bot's browser: an audio request gets a
 * track from a Web Audio destination the companion plays clips into, a video request gets a black frame. The
 * real devices are never opened (the browser is also started with a silent fake capture file, so even a path
 * around this wrapper hears nothing). `window.__nexAvaMic` plays a base64 WAV into the microphone and stops it.
 */
export const MIC_SCRIPT = `(() => {
  if (window.__nexAvaMic) return;
  const devices = navigator.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== 'function') return;
  let context = null;
  let destination = null;
  let source = null;
  const ensure = () => {
    if (!context) {
      context = new AudioContext({ sampleRate: 48000 });
      destination = context.createMediaStreamDestination();
    }
    return context;
  };
  const blackTrack = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const paint = canvas.getContext('2d');
    paint.fillStyle = '#000';
    paint.fillRect(0, 0, 640, 360);
    return canvas.captureStream(1).getVideoTracks()[0];
  };
  const getUserMedia = async constraints => {
    const tracks = [];
    if (constraints && constraints.audio) {
      ensure();
      tracks.push(destination.stream.getAudioTracks()[0].clone());
    }
    if (constraints && constraints.video) tracks.push(blackTrack());
    if (!tracks.length) throw new DOMException('Requested device not found', 'NotFoundError');
    return new MediaStream(tracks);
  };
  Object.defineProperty(devices, 'getUserMedia', { value: getUserMedia, configurable: false, writable: false });
  const stop = () => {
    const playing = source;
    source = null;
    if (playing) {
      try { playing.stop(); } catch (error) {}
      playing.disconnect();
    }
  };
  const play = async base64 => {
    ensure();
    await context.resume();
    stop();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const buffer = await context.decodeAudioData(bytes.buffer);
    const clip = context.createBufferSource();
    clip.buffer = buffer;
    clip.connect(destination);
    clip.onended = () => { if (source === clip) source = null; };
    source = clip;
    clip.start();
    return Math.round(buffer.duration * 1000);
  };
  const api = Object.freeze({ play, stop, speaking: () => source !== null });
  Object.defineProperty(window, '__nexAvaMic', { value: api, configurable: false, writable: false });
})();`;

export type MeetPhase =
  // Google's sign-in page
  | 'signin'
  // Not Meet at all (signed out, Meet sends you to its product page)
  | 'elsewhere'
  | 'loading'
  // The green room: Join now / Ask to join
  | 'lobby'
  | 'waiting'
  | 'in_call'
  | 'ended'
  | 'removed'
  | 'denied';

export interface MeetReading {
  phase: MeetPhase;
  // In the lobby: whether it asks for a name (a guest, not signed in), and the camera and mic as shown
  asksName: boolean;
  cameraOn: boolean;
  micOff: boolean;
}

/** Reads where the page is. Text checks first: the end screens keep some buttons of the call around. */
export const READ_STATE = `(() => {
  const host = location.hostname;
  if (host === 'accounts.google.com') return { phase: 'signin', asksName: false, cameraOn: false, micOff: false };
  if (host !== 'meet.google.com') return { phase: 'elsewhere', asksName: false, cameraOn: false, micOff: false };
  const text = ((document.body && document.body.innerText) || '').slice(0, 20000);
  const visible = element => element.getClientRects().length > 0;
  const labels = [...document.querySelectorAll('button,[role="button"]')]
    .filter(visible)
    .map(b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.innerText || b.textContent || '')).replace(/\\s+/g, ' ').trim());
  const has = re => labels.some(label => re.test(label));
  const asksName = [...document.querySelectorAll('input')].some(input => visible(input) && /your name/i.test(input.getAttribute('aria-label') || input.placeholder || ''));
  const base = { asksName, cameraOn: has(/turn off camera/i), micOff: has(/turn on microphone/i) };
  if (/removed you from the (meeting|call)|you('ve| have) been removed|you were removed/i.test(text)) return { ...base, phase: 'removed' };
  if (/denied your request|no one responded to your request|can(no|')t join this call|you can't join/i.test(text)) return { ...base, phase: 'denied' };
  if (/you left the (meeting|call)|the (call|meeting) has ended|call ended for everyone|you've left the call/i.test(text) || has(/^\\| ?rejoin$/i)) return { ...base, phase: 'ended' };
  if (has(/leave call/i)) return { ...base, phase: 'in_call' };
  if (/asking to be let in|lets you in|wait until a meeting host|waiting for the host|someone to let you in/i.test(text)) return { ...base, phase: 'waiting' };
  if (has(/(^|\\| ?)(join now|ask to join)$/i)) return { ...base, phase: 'lobby' };
  return { ...base, phase: 'loading' };
})()`;

/** Presses the first visible control whose accessible name or words match; true when one was pressed. */
export function clickExpression(pattern: RegExp): string {
  return `(() => {
  const re = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
  const visible = element => element.getClientRects().length > 0;
  const target = [...document.querySelectorAll('button,[role="button"]')].find(b => {
    if (!visible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
    const label = (b.getAttribute('aria-label') || '').trim();
    const words = (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').trim();
    return re.test(label) || re.test(words);
  });
  if (!target) return false;
  target.click();
  return true;
})()`;
}

export const CONTROLS = {
  join: /^(join now|ask to join)$/i,
  cameraOff: /^turn off camera/i,
  micOn: /^turn on microphone/i,
  leave: /^leave call$/i,
  // Notices that cover the page now and then
  dismiss: /^(got it|dismiss|close)$/i,
} as const;

/** Plays a clip into the bot's microphone; resolves to its length in milliseconds. */
export const playExpression = (base64: string) => `window.__nexAvaMic.play(${JSON.stringify(base64)})`;
export const STOP_EXPRESSION = `(window.__nexAvaMic && window.__nexAvaMic.stop(), true)`;
export const SPEAKING_EXPRESSION = `Boolean(window.__nexAvaMic && window.__nexAvaMic.speaking())`;
