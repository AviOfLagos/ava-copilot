import { stepTextScale, THEME_CHOICES } from '@appearance';
import type { AppearanceSettingsConfig, Density } from '@appearance';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AvaBridge, BrainView } from '../shared/ipc';
import { applyAppearance, cachedAppearance } from './appearance';
import { addSent, applyReplies, emptyChat, markFailed, newChatId, restoreChat } from './chat';
import type { ChatLine, ChatState } from './chat';

declare global {
  interface Window {
    ava: AvaBridge;
  }
}

const CHAT_KEY = 'ava-desktop-chat';
const READ_MS = 1500;
const STATUS_MS = 5000;

const THEME_LABEL: Record<AppearanceSettingsConfig['theme'], string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};
const DENSITY_LABEL: Record<Density, string> = { compact: 'Compact', comfortable: 'Comfortable', roomy: 'Roomy' };

function loadChat(): ChatState {
  try {
    return restoreChat(JSON.parse(localStorage.getItem(CHAT_KEY) ?? 'null'), newChatId());
  } catch {
    return emptyChat(newChatId());
  }
}

function Chip({ tone, children }: { tone: 'ok' | 'off' | 'hold'; children: React.ReactNode }) {
  return (
    <span className={`chip chip-${tone}`}>
      <span className="dot" aria-hidden />
      {children}
    </span>
  );
}

function StatusChips({ brain }: { brain: BrainView | null }) {
  if (!brain) return <Chip tone="off">Looking for Ava Brain…</Chip>;
  if (brain.state === 'off') return <Chip tone="off">{brain.message}</Chip>;
  return (
    <>
      <Chip tone="ok">Ava Brain {brain.version}</Chip>
      <Chip tone={brain.browserOpen ? 'ok' : 'hold'}>{brain.browserOpen ? 'Browser connected' : 'Browser closed'}</Chip>
      <Chip tone={brain.whatsapp === 'linked' ? 'ok' : 'off'}>
        WhatsApp {brain.whatsapp === 'linked' ? 'linked' : brain.whatsapp.replace('_', ' ')}
      </Chip>
    </>
  );
}

function Line({ line }: { line: ChatLine }) {
  if (line.role === 'note') return <div className={`note note-${line.tone}`}>{line.text}</div>;
  return (
    <div className={`bubble bubble-${line.role}`}>
      <div className="bubble-text">{line.text}</div>
      {line.role === 'you' && line.failed ? <div className="bubble-failed">Not sent: {line.failed}</div> : null}
    </div>
  );
}

function LookMenu({
  settings,
  onChange,
}: {
  settings: AppearanceSettingsConfig;
  onChange: (changes: Partial<AppearanceSettingsConfig>) => void;
}) {
  return (
    <div className="look" role="group" aria-label="Look">
      <button
        type="button"
        className="icon"
        aria-label="Smaller text"
        onClick={() => onChange({ textScale: stepTextScale(settings.textScale, -1) })}>
        A−
      </button>
      <span className="look-value" aria-live="polite">
        {settings.textScale}%
      </span>
      <button
        type="button"
        className="icon"
        aria-label="Larger text"
        onClick={() => onChange({ textScale: stepTextScale(settings.textScale, 1) })}>
        A+
      </button>
      <select
        aria-label="Theme"
        value={settings.theme}
        onChange={event => onChange({ theme: event.target.value as AppearanceSettingsConfig['theme'] })}>
        {THEME_CHOICES.map(theme => (
          <option key={theme} value={theme}>
            {THEME_LABEL[theme]}
          </option>
        ))}
      </select>
      <select
        aria-label="Spacing"
        value={settings.density}
        onChange={event => onChange({ density: event.target.value as Density })}>
        {(Object.keys(DENSITY_LABEL) as Density[]).map(density => (
          <option key={density} value={density}>
            {DENSITY_LABEL[density]}
          </option>
        ))}
      </select>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<AppearanceSettingsConfig>(cachedAppearance);
  const [systemDark, setSystemDark] = useState(true);
  const [brain, setBrain] = useState<BrainView | null>(null);
  const [chat, setChat] = useState<ChatState>(loadChat);
  const [draft, setDraft] = useState('');
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const bottom = useRef<HTMLDivElement>(null);
  const ready = useRef(false);

  // Appearance: the record from the main process, the system's dark mode, applied as on the panel
  useEffect(() => {
    void window.ava.appearance().then(setSettings);
    void window.ava.systemDark().then(setSystemDark);
    return window.ava.onSystemTheme(setSystemDark);
  }, []);
  useEffect(() => applyAppearance(settings, systemDark), [settings, systemDark]);
  const changeLook = useCallback((changes: Partial<AppearanceSettingsConfig>) => {
    setSettings(current => ({ ...current, ...changes }));
    void window.ava.setAppearance(changes).then(setSettings);
  }, []);

  // Ava Brain's health
  useEffect(() => {
    const read = () => void window.ava.brainStatus().then(setBrain);
    read();
    const timer = setInterval(read, STATUS_MS);
    return () => clearInterval(timer);
  }, []);

  // Answers: from now on when the window opens, then every second and a half
  useEffect(() => {
    let stopped = false;
    const timer = setInterval(async () => {
      if (!ready.current) {
        // Where Ava Brain's answers are now; until it can say, nothing old is read again
        const seq = await window.ava.startSeq();
        if (stopped || seq === null) return;
        setChat(current => ({ ...current, seq: Math.max(current.seq, seq) }));
        ready.current = true;
        return;
      }
      const { replies, restarted } = await window.ava.replies(chatRef.current.seq);
      if (replies.length || restarted) setChat(current => applyReplies(current, replies, restarted));
    }, READ_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(CHAT_KEY, JSON.stringify({ chatId: chat.chatId, lines: chat.lines }));
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat.chatId, chat.lines]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const id = `m${Date.now()}`;
    setDraft('');
    setChat(current => addSent(current, text, Date.now(), id));
    const result = await window.ava.send(chatRef.current.chatId, text);
    if (!result.ok) setChat(current => markFailed(current, id, result.message ?? 'Ava Brain did not take it.'));
  };

  const browserClosed = brain?.state === 'on' && !brain.browserOpen;

  return (
    <div className="app aura">
      <header className="top">
        <div className="brand">
          <span className="orb" aria-hidden />
          <span>Ava</span>
        </div>
        <div className="chips">
          <StatusChips brain={brain} />
        </div>
        <LookMenu settings={settings} onChange={changeLook} />
        <button type="button" className="ghost" onClick={() => setChat(emptyChat(newChatId(), chat.seq))}>
          New chat
        </button>
      </header>

      <main className="chat" aria-live="polite">
        {chat.lines.length === 0 ? (
          <div className="empty">
            <h1>What can I do for you?</h1>
            <p>Ask anything. I work in your browser and on this Mac, with everything I can do in the side panel.</p>
          </div>
        ) : (
          chat.lines.map(line => <Line key={line.id} line={line} />)
        )}
        {chat.working ? <div className="working">Ava is working…</div> : null}
        <div ref={bottom} />
      </main>

      <footer className="composer glass">
        {browserClosed ? (
          <div className="note note-hold">Your browser is closed. Open it and I'll answer; your message waits.</div>
        ) : null}
        <form
          onSubmit={event => {
            event.preventDefault();
            void send();
          }}>
          <textarea
            aria-label="Message Ava"
            placeholder="Message Ava"
            value={draft}
            rows={2}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" className="primary" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}
