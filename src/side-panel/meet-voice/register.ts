// Esc stops Ava speaking in a call, wherever the panel is: the meeting card shows the Stop button, this is the key.
import { meetVoiceStore } from '@src/background/meet-voice/state';
import { registerSettingsSection } from '../registry';
import AvaAccount from './AvaAccount';
import { sendMeetVoice } from './send';

// Settings › Meetings › Ava's meeting account (options.html#meetings/ava)
registerSettingsSection({
  id: 'meetings-ava',
  label: 'meetvoice_account_title',
  page: 'meetings',
  order: 5,
  keywords: ['ava', 'meet', 'google meet', 'account', 'sign in', 'join', 'participant'],
  Component: AvaAccount,
});

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
