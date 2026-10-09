import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import {
  AgentNameEnum,
  ProviderTypeEnum,
  agentModelStore,
  db,
  llmProviderStore,
  meetingSettingsStore,
  threadStore,
  type KbAnswer,
  type KbCitation,
} from '@extension/storage';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import Composer from './components/Composer';
import ConfirmCard from './components/ConfirmCard';
import BookmarkList from './components/BookmarkList';
import { Button } from './components/ui/button';
import { LiveOrb } from './components/ui/live-orb';
import { ThinkingOrb } from './components/ui/thinking-orb';
import ChatView from './chat/ChatView';
import Header from './layout/Header';
import { useTheme } from './layout/theme';
import HomeView from './home/HomeView';
import VoiceView from './voice/VoiceView';
import TodayView from './today/TodayView';
import SettingsView from './settings/SettingsView';
import ThreadList from './threads/ThreadList';
import ThreadBar from './threads/ThreadBar';
import MeetingView, { clock, useElapsed } from './meetings/MeetingView';
import ConsentDialog from './meetings/ConsentDialog';
import KnowledgeView from './kb/KnowledgeView';
import TeachCard from './skills/TeachCard';
import { useLive } from './hooks/useLive';
import { useSpeechInput } from './hooks/useSpeechInput';

// A thread tag: the user answered "Save as skill?" for this chat
const SKILL_OFFERED_TAG = 'skill:offered';

const HEARTBEAT_MS = 25_000;

// A popped-out panel opens on the thread named in its address
const threadFromUrl = () => new URLSearchParams(location.search).get('thread');

type PanelMessage =
  | { type: 'thread_started'; clientId: string; threadId: string }
  | { type: 'meeting_started'; clientId: string; meetingId: string }
  | { type: 'meeting_answer'; clientId: string; answer: string }
  | ({ type: 'kb_answer'; clientId: string } & KbAnswer)
  | { type: 'kb_saved'; clientId: string; title: string }
  | { type: 'skill_draft'; clientId: string; markdown: string }
  | { type: 'voice_started'; ok: boolean; micDenied?: boolean; error?: string }
  | { type: 'error'; error: string; clientId?: string; threadId?: string | null }
  | { type: 'speech_to_text_result'; text: string }
  | { type: 'speech_to_text_error'; error: string }
  | { type: 'heartbeat_ack' };

const SidePanel = () => {
  const { dark: isDarkMode } = useTheme();
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null);
  const [threadId, setThreadId] = useState<string | null>(threadFromUrl);
  const [showList, setShowList] = useState(false);
  // The meeting shown instead of a thread, and whether the recording reminder is up
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [showKb, setShowKb] = useState(false);
  // The voice screen was put away while the conversation goes on
  const [voiceHidden, setVoiceHidden] = useState(false);
  const [showToday, setShowToday] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [savedSkillIn, setSavedSkillIn] = useState<string | null>(null);
  // Where a citation points in the meeting's transcript, in seconds
  const [meetingFocusT, setMeetingFocusT] = useState<number | null>(null);
  const [consent, setConsent] = useState<{ includeMic: boolean } | null>(null);
  // The spoken conversation, as the offscreen document reports it
  const [voiceStatus, setVoiceStatus] = useState<'off' | 'connecting' | 'listening' | 'speaking'>('off');
  // A problem to show above the input that belongs to no message, e.g. a send that was refused
  const [banner, setBanner] = useState<string | null>(null);
  // A short good-news line, e.g. a page saved
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);
  // Sends waiting to learn the id of the thread they created
  const pendingSendsRef = useRef(new Set<string>());
  // Questions about a meeting waiting for their answer
  const pendingAsksRef = useRef(new Map<string, () => void>());
  // Knowledge base questions and page saves waiting for the background's reply
  const pendingKbRef = useRef(new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>());

  const thread = useLive(
    () => (threadId ? threadStore.get(threadId) : Promise.resolve(undefined)),
    [threadId],
    undefined,
  );
  const threadMessages = useLive(
    () => (threadId ? threadStore.messages(threadId) : Promise.resolve([])),
    [threadId],
    [],
  );
  const activeCount = useLive(() => db.threads.where('status').anyOf('running', 'waiting_confirm').count(), [], 0);
  const recording = useLive(() => db.meetings.where('status').equals('recording').first(), [], undefined);
  const recordingFor = useElapsed(recording);

  const isBusy = thread?.status === 'running' || thread?.status === 'waiting_confirm';
  // After a browsing task that worked, offer once to save what it learned as a skill
  const canTeach =
    thread?.status === 'idle' &&
    !thread.error &&
    !thread.meetingId &&
    !thread.tags.includes(SKILL_OFFERED_TAG) &&
    threadMessages.some(message => message.actor === 'navigator') &&
    threadMessages.at(-1)?.actor === 'planner';

  // A task cannot run without a Navigator model whose provider has an API key
  const checkModelConfiguration = useCallback(async () => {
    try {
      const navigatorModel = await agentModelStore.getAgentModel(AgentNameEnum.Navigator);
      const provider = navigatorModel ? await llmProviderStore.getProvider(navigatorModel.provider) : undefined;
      // Local and custom OpenAI-compatible providers can run without a key
      const keyOptional =
        provider?.type === ProviderTypeEnum.Ollama || provider?.type === ProviderTypeEnum.CustomOpenAI;
      setHasConfiguredModels(!!provider && (keyOptional || provider.apiKey.trim() !== ''));
    } catch (error) {
      console.error('Error checking model configuration:', error);
      setHasConfiguredModels(false);
    }
  }, []);

  useEffect(() => {
    void checkModelConfiguration();
    const recheck = () => !document.hidden && void checkModelConfiguration();
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, [checkModelConfiguration]);

  useEffect(() => {
    favoritesStorage
      .getAllPrompts()
      .then(setFavoritePrompts)
      .catch(error => console.error('Failed to load favorite prompts:', error));
  }, []);

  const speech = useSpeechInput(
    useCallback(audio => postRef.current({ type: 'speech_to_text', audio }), []),
    useCallback((message: string) => setBanner(message), []),
  );
  const { setIsProcessingSpeech } = speech;

  const onPortMessage = useCallback(
    (message: PanelMessage) => {
      switch (message.type) {
        case 'thread_started':
          if (pendingSendsRef.current.delete(message.clientId)) {
            setThreadId(message.threadId);
            setSending(false);
          }
          break;
        case 'meeting_started':
          setMeetingId(message.meetingId);
          setShowList(false);
          break;
        case 'voice_started':
          if (message.micDenied) {
            setVoiceStatus('off');
            setBanner(t('voice_micNeeded'));
            void chrome.windows.create({
              url: chrome.runtime.getURL('permission/index.html'),
              type: 'popup',
              width: 500,
              height: 600,
            });
          } else if (!message.ok) {
            setVoiceStatus('off');
            setBanner(message.error || t('errors_unknown'));
          }
          break;
        case 'meeting_answer':
          pendingAsksRef.current.get(message.clientId)?.();
          pendingAsksRef.current.delete(message.clientId);
          break;
        case 'kb_answer':
          pendingKbRef.current.get(message.clientId)?.resolve({ answer: message.answer, citations: message.citations });
          pendingKbRef.current.delete(message.clientId);
          break;
        case 'skill_draft':
          pendingKbRef.current.get(message.clientId)?.resolve(message.markdown);
          pendingKbRef.current.delete(message.clientId);
          break;
        case 'kb_saved':
          pendingKbRef.current.get(message.clientId)?.resolve(message.title);
          pendingKbRef.current.delete(message.clientId);
          break;
        case 'error':
          if (message.clientId && pendingKbRef.current.has(message.clientId)) {
            pendingKbRef.current.get(message.clientId)?.reject(new Error(message.error || t('errors_unknown')));
            pendingKbRef.current.delete(message.clientId);
            break;
          }
          if (message.clientId && pendingAsksRef.current.has(message.clientId)) {
            pendingAsksRef.current.get(message.clientId)?.();
            pendingAsksRef.current.delete(message.clientId);
          }
          if (message.clientId) {
            pendingSendsRef.current.delete(message.clientId);
            setSending(false);
          }
          setBanner(message.error || t('errors_unknown'));
          break;
        case 'speech_to_text_result':
          if (message.text) setInputTextRef.current?.(message.text);
          setIsProcessingSpeech(false);
          break;
        case 'speech_to_text_error':
          setBanner(message.error || t('chat_stt_recognitionFailed'));
          setIsProcessingSpeech(false);
          break;
      }
    },
    [setIsProcessingSpeech],
  );

  // One connection for the life of the panel; it reconnects if the background restarts
  const connect = useCallback((): chrome.runtime.Port => {
    if (portRef.current) {
      return portRef.current;
    }
    const port = chrome.runtime.connect({ name: 'side-panel-connection' });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    });
    heartbeatRef.current = window.setInterval(() => {
      try {
        portRef.current?.postMessage({ type: 'heartbeat' });
      } catch {
        portRef.current = null;
      }
    }, HEARTBEAT_MS);
    portRef.current = port;
    return port;
  }, [onPortMessage]);

  const post = useCallback((message: Record<string, unknown>) => connect().postMessage(message), [connect]);
  const postRef = useRef(post);
  postRef.current = post;

  useEffect(() => {
    connect();
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [connect]);

  const currentWindowId = async () => (await chrome.windows.getCurrent()).id;

  const handleSend = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isBusy || sending) return;
    setBanner(null);
    const clientId = crypto.randomUUID();
    if (!threadId) {
      // A new thread gets its id from the background; until then the input waits
      pendingSendsRef.current.add(clientId);
      setSending(true);
    }
    try {
      post({ type: 'thread_send', clientId, threadId, text: trimmed, windowId: await currentWindowId() });
    } catch (error) {
      pendingSendsRef.current.delete(clientId);
      setSending(false);
      setBanner(error instanceof Error ? error.message : String(error));
    }
  };

  const handleStop = () => threadId && post({ type: 'thread_cancel', threadId });

  const handleConfirmAnswer = (approved: boolean, replies?: string[]) => {
    const request = thread?.pendingRequest;
    if (request && threadId) {
      post({ type: 'confirm_action', threadId, requestId: request.id, approved, replies });
    }
  };

  // A thread waiting for a click that is not the one on screen, e.g. a task started by voice
  const waiting = useLive(() => db.threads.where('status').equals('waiting_confirm').toArray(), [], []);
  // One card at a time: the thread on screen comes first
  const elsewhere = thread?.pendingRequest
    ? undefined
    : waiting.find(other => other.id !== threadId && other.pendingRequest);

  const startNotes = async (includeMic: boolean) => {
    setConsent(null);
    setBanner(null);
    await meetingSettingsStore.updateSettings({ consentShown: true, includeMic });
    post({
      type: 'meeting_start',
      clientId: crypto.randomUUID(),
      windowId: await currentWindowId(),
      withMic: includeMic,
    });
  };

  const handleTakeNotes = async () => {
    if (recording) {
      setShowKb(false);
      setMeetingFocusT(null);
      setMeetingId(recording.id);
      setShowList(false);
      return;
    }
    const settings = await meetingSettingsStore.getSettings();
    // The first recording shows the reminder to tell participants
    if (!settings.consentShown) setConsent({ includeMic: settings.includeMic });
    else await startNotes(settings.includeMic);
  };

  // The offscreen document tells every page how the conversation is going
  useEffect(() => {
    const onStatus = (message: { type?: string; status?: typeof voiceStatus; error?: string }) => {
      if (message?.type !== 'voice_status' || !message.status) return;
      setVoiceStatus(message.status);
      if (message.error) setBanner(message.error);
    };
    chrome.runtime.onMessage.addListener(onStatus);
    return () => chrome.runtime.onMessage.removeListener(onStatus);
  }, []);

  const toggleVoice = async () => {
    setBanner(null);
    if (voiceStatus !== 'off') {
      setVoiceStatus('off');
      post({ type: 'voice_stop' });
      return;
    }
    setVoiceHidden(false);
    setVoiceStatus('connecting');
    post({ type: 'voice_start', windowId: await currentWindowId() });
  };

  // Sends a knowledge base request and waits for its reply
  const kbRequest = <T,>(message: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const clientId = crypto.randomUUID();
      pendingKbRef.current.set(clientId, { resolve: value => resolve(value as T), reject });
      try {
        post({ ...message, clientId });
      } catch (error) {
        pendingKbRef.current.delete(clientId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const openCitation = (citation: KbCitation) => {
    const { anchor } = citation;
    if (anchor.kind === 'note') {
      // A note lives in memory itself
      setShowKb(true);
    } else if (anchor.kind === 'page') {
      void chrome.tabs.create({ url: anchor.url });
    } else if (anchor.kind === 'meeting') {
      setShowKb(false);
      setShowList(false);
      setMeetingFocusT(anchor.t);
      setMeetingId(anchor.meetingId);
    } else {
      handleSelect(anchor.threadId);
    }
  };

  const handleNewThread = () => {
    setShowSettings(false);
    setShowToday(false);
    setShowKb(false);
    setMeetingId(null);
    setThreadId(null);
    setShowList(false);
    setBanner(null);
  };

  const handleSelect = (id: string) => {
    setShowSettings(false);
    setShowToday(false);
    setShowKb(false);
    setMeetingId(null);
    setThreadId(id);
    setShowList(false);
    setBanner(null);
  };

  const handleDelete = (id: string) => {
    post({ type: 'thread_delete', threadId: id });
    if (id === threadId) setThreadId(null);
  };

  // Good news fades on its own
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleBranch = async (seq: number) => {
    if (!threadId) return;
    const fork = await threadStore.fork(threadId, seq);
    setThreadId(fork.id);
  };

  const handlePopOut = async () => {
    const url = chrome.runtime.getURL(`sidepanel.html${threadId ? `?thread=${threadId}` : ''}`);
    await chrome.windows.create({ url, type: 'popup', width: 440, height: 760 });
  };

  const savePage = async () => {
    setBanner(null);
    try {
      setNotice(t('kb_saved', [await kbRequest<string>({ type: 'kb_save_page', windowId: await currentWindowId() })]));
    } catch (error) {
      setBanner(error instanceof Error ? error.message : String(error));
    }
  };

  const openSettings = () => {
    setShowSettings(!showSettings);
    setShowList(false);
  };

  const view: 'consent' | 'list' | 'settings' | 'kb' | 'today' | 'meeting' | 'checking' | 'welcome' | 'chat' | 'home' =
    consent
      ? 'consent'
      : showList
        ? 'list'
        : showSettings
          ? 'settings'
          : showToday
            ? 'today'
            : showKb
              ? 'kb'
              : meetingId
                ? 'meeting'
                : hasConfiguredModels === null
                  ? 'checking'
                  : hasConfiguredModels === false
                    ? 'welcome'
                    : thread && threadMessages.length > 0
                      ? 'chat'
                      : 'home';

  const title =
    view === 'list'
      ? t('threads_list_title')
      : view === 'kb'
        ? t('kb_title')
        : view === 'today'
          ? t('today_title')
          : view === 'settings'
            ? t('settings_title')
            : thread?.title || t('threads_untitled');

  const alerts = (
    <>
      {banner && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 mb-2 rounded-xl border px-3 py-2 text-[12.5px]">
          {banner}
        </div>
      )}
      {notice && (
        <div role="status" className="border-primary/40 bg-primary/10 mb-2 rounded-xl border px-3 py-2 text-[12.5px]">
          {notice}
        </div>
      )}
    </>
  );

  const composer = (
    <div className="shrink-0 px-2.5 pb-2.5 pt-1">
      {thread?.pendingRequest && view === 'chat' && (
        <ConfirmCard request={thread.pendingRequest} onAnswer={handleConfirmAnswer} isDarkMode={isDarkMode} />
      )}
      {alerts}
      <Composer
        onSendMessage={text => void handleSend(text)}
        onStopTask={handleStop}
        onMicClick={() => void speech.toggle()}
        isRecording={speech.isRecording}
        isProcessingSpeech={speech.isProcessingSpeech}
        disabled={isBusy || sending}
        showStopButton={isBusy}
        setContent={setter => {
          setInputTextRef.current = setter;
        }}
      />
      <p className="text-muted-foreground mt-1.5 text-center text-[10.5px]">{t('chat_footer_gate')}</p>
    </div>
  );

  return (
    <div className="aura text-foreground relative flex h-screen flex-col overflow-hidden font-sans">
      {voiceStatus !== 'off' && !voiceHidden && (
        <VoiceView status={voiceStatus} onEnd={() => void toggleVoice()} onHide={() => setVoiceHidden(true)} />
      )}
      <Header
        title={title}
        listOpen={showList}
        onToggleList={() => setShowList(!showList)}
        busy={activeCount > 0 || voiceStatus !== 'off'}
        kbOpen={showKb && !showList}
        onToggleKb={() => {
          setShowKb(!showKb);
          setShowList(false);
          setShowToday(false);
          setShowSettings(false);
        }}
        recordingLabel={recording ? clock(recordingFor) : null}
        onNotes={() => void handleTakeNotes()}
        voiceStatus={voiceStatus}
        // A hidden conversation comes back to the front; otherwise the button starts or ends it
        onVoice={() => (voiceStatus !== 'off' && voiceHidden ? setVoiceHidden(false) : void toggleVoice())}
        onNewThread={handleNewThread}
        onSettings={openSettings}
        settingsOpen={showSettings}
        activeCount={activeCount}
        onStopAll={() => post({ type: 'thread_cancel_all' })}
      />

      {elsewhere?.pendingRequest && (
        <div className="px-2.5 pt-2">
          <p className="text-muted-foreground mb-1 text-[11.5px]">
            {t('threads_waitingElsewhere', [elsewhere.title || t('threads_untitled')])}
          </p>
          <ConfirmCard
            request={elsewhere.pendingRequest}
            onAnswer={(approved, replies) =>
              post({
                type: 'confirm_action',
                threadId: elsewhere.id,
                requestId: elsewhere.pendingRequest!.id,
                approved,
                replies,
              })
            }
            isDarkMode={isDarkMode}
          />
        </div>
      )}

      {view === 'consent' && consent && (
        <ConsentDialog
          includeMic={consent.includeMic}
          onStart={withMic => void startNotes(withMic)}
          onCancel={() => setConsent(null)}
          isDarkMode={isDarkMode}
        />
      )}

      {view === 'list' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex justify-end px-3 pt-2">
            <Button variant="ghost" size="sm" onClick={() => void handlePopOut()} aria-label={t('threads_popOut')}>
              <ExternalLink className="size-3.5" />
              {t('threads_popOut')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ThreadList
              activeThreadId={threadId}
              onSelect={handleSelect}
              onDelete={handleDelete}
              isDarkMode={isDarkMode}
            />
          </div>
        </div>
      )}

      {view === 'kb' && (
        <KnowledgeView
          onAsk={question => kbRequest<KbAnswer>({ type: 'kb_ask', question })}
          onSavePage={async () => kbRequest<string>({ type: 'kb_save_page', windowId: await currentWindowId() })}
          onDelete={itemId => post({ type: 'kb_delete', itemId })}
          onOpenCitation={openCitation}
          isDarkMode={isDarkMode}
        />
      )}

      {view === 'settings' && <SettingsView onBack={() => setShowSettings(false)} />}

      {view === 'today' && (
        <>
          <div className="px-3 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setShowToday(false)}>
              <ArrowLeft className="size-3.5" />
              {t('today_back')}
            </Button>
          </div>
          <TodayView />
        </>
      )}

      {view === 'meeting' && meetingId && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="px-2.5 pt-2">{alerts}</div>
          <MeetingView
            meetingId={meetingId}
            onStop={() => post({ type: 'meeting_stop', meetingId })}
            onRetry={() => post({ type: 'meeting_retry', meetingId })}
            onOpenThread={id => handleSelect(id)}
            onAsk={question =>
              new Promise<void>(resolve => {
                const clientId = crypto.randomUUID();
                pendingAsksRef.current.set(clientId, resolve);
                setBanner(null);
                post({ type: 'meeting_ask', clientId, meetingId, question });
              })
            }
            onRefreshSummary={() => post({ type: 'meeting_summarize', meetingId })}
            focusT={meetingFocusT}
            isDarkMode={isDarkMode}
          />
        </div>
      )}

      {view === 'checking' && (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-4">
          <ThinkingOrb size={72} />
          <p className="text-sm">{t('status_checkingConfig')}</p>
        </div>
      )}

      {view === 'welcome' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
          <LiveOrb size={132} label={t('home_orb')} />
          <div className="space-y-2">
            <h3 className="text-lg font-medium tracking-tight">{t('welcome_title')}</h3>
            <p className="text-muted-foreground text-sm">{t('welcome_instruction')}</p>
          </div>
          <Button size="lg" onClick={() => chrome.runtime.openOptionsPage()}>
            {t('welcome_openSettings')}
          </Button>
        </div>
      )}

      {view === 'chat' && thread && (
        <>
          <ThreadBar
            thread={thread}
            onPopOut={() => void handlePopOut()}
            onRebind={async () =>
              post({ type: 'thread_rebind', threadId: thread.id, windowId: await currentWindowId() })
            }
            onContinue={async () =>
              post({ type: 'thread_continue', threadId: thread.id, windowId: await currentWindowId() })
            }
            onOpenMeeting={
              thread.meetingId
                ? () => {
                    setMeetingFocusT(null);
                    setMeetingId(thread.meetingId);
                  }
                : undefined
            }
            isDarkMode={isDarkMode}
          />
          <ChatView
            thread={thread}
            messages={threadMessages}
            onBranch={isBusy ? undefined : seq => void handleBranch(seq)}
            footer={
              (canTeach || savedSkillIn === thread.id) && (
                <TeachCard
                  key={thread.id}
                  onDraft={() => kbRequest<string>({ type: 'skill_teach', threadId: thread.id })}
                  onDone={saved => {
                    // A saved skill keeps its card, to show the name it is called by
                    if (saved) setSavedSkillIn(thread.id);
                    void threadStore.update(thread.id, { tags: [...thread.tags, SKILL_OFFERED_TAG] });
                  }}
                  isDarkMode={isDarkMode}
                />
              )
            }
          />
          {composer}
        </>
      )}

      {view === 'home' && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <HomeView
              onPrompt={text => setInputTextRef.current?.(text)}
              onOpenKb={() => setShowKb(true)}
              onTakeNotes={() => void handleTakeNotes()}
              onSavePage={() => void savePage()}
              onOpenToday={() => setShowToday(true)}>
              {favoritePrompts.length > 0 && (
                <BookmarkList
                  bookmarks={favoritePrompts}
                  onBookmarkSelect={content => setInputTextRef.current?.(content)}
                  onBookmarkUpdateTitle={async (id, title) => {
                    await favoritesStorage.updatePromptTitle(id, title);
                    setFavoritePrompts(await favoritesStorage.getAllPrompts());
                  }}
                  onBookmarkDelete={async id => {
                    await favoritesStorage.removePrompt(id);
                    setFavoritePrompts(await favoritesStorage.getAllPrompts());
                  }}
                  onBookmarkReorder={async (draggedId, targetId) => {
                    await favoritesStorage.reorderPrompts(draggedId, targetId);
                    setFavoritePrompts(await favoritesStorage.getAllPrompts());
                  }}
                  isDarkMode={isDarkMode}
                />
              )}
            </HomeView>
          </div>
          {composer}
        </>
      )}
    </div>
  );
};

export default SidePanel;
