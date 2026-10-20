// Esc stops Ava speaking in a call, wherever the panel is: the meeting card shows the Stop button, this is the key.
import { meetVoiceStore } from '@src/background/meet-voice/state';
import { sendMeetVoice } from './send';

let speaking = false;
const read = () =>
  void meetVoiceStore
    .getState()
    .then(state => {
      speaking = state.status?.state === 'in_call' && state.status.speaking;
    })
    .catch(() => {});
read();
meetVoiceStore.subscribe(read);

window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !speaking) return;
  speaking = false;
  void sendMeetVoice({ type: 'meetvoice_stop' }).catch(() => {});
});
