import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FiExternalLink, FiList, FiSettings } from 'react-icons/fi';
import { PiPlusBold, PiRecordBold } from 'react-icons/pi';
import {
  type Message,
  Actors,
  AgentNameEnum,
  ProviderTypeEnum,
  agentModelStore,
  db,
  llmProviderStore,
  meetingSettingsStore,
  threadStore,
} from '@extension/storage';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import ConfirmCard from './components/ConfirmCard';
import UsageBadge from './components/UsageBadge';
import BookmarkList from './components/BookmarkList';
import ThreadList from './threads/ThreadList';
import ThreadBar from './threads/ThreadBar';
import MeetingView, { clock, useElapsed } from './meetings/MeetingView';
import ConsentDialog from './meetings/ConsentDialog';
import { useLive } from './hooks/useLive';
import { useSpeechInput } from './hooks/useSpeechInput';
import './SidePanel.css';

const PROGRESS = 'Showing progress...';
const HEARTBEAT_MS = 25_000;

// A popped-out panel opens on the thread named in its address
const threadFromUrl = () => new URLSearchParams(location.search).get('thread');

type PanelMessage =
  | { type: 'thread_started'; clientId: string; threadId: string }
  | { type: 'meeting_started'; clientId: string; meetingId: string }
  | { type: 'meeting_answer'; clientId: string; answer: string }
  | { type: 'error'; error: string; clientId?: string; threadId?: string | null }
  | { type: 'speech_to_text_result'; text: string }
  | { type: 'speech_to_text_error'; error: string }
  | { type: 'heartbeat_ack' };

const SidePanel = () => {
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null);
  const [threadId, setThreadId] = useState<string | null>(threadFromUrl);
  const [showList, setShowList] = useState(false);
  // The meeting shown instead of a thread, and whether the recording reminder is up
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [consent, setConsent] = useState<{ includeMic: boolean } | null>(null);
  // A problem to show above the input that belongs to no message, e.g. a send that was refused
  const [banner, setBanner] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Sends waiting to learn the id of the thread they created
  const pendingSendsRef = useRef(new Set<string>());
  // Questions about a meeting waiting for their answer
  const pendingAsksRef = useRef(new Map<string, () => void>());

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

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(query.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

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
        case 'meeting_answer':
          pendingAsksRef.current.get(message.clientId)?.();
          pendingAsksRef.current.delete(message.clientId);
          break;
        case 'error':
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

  const handleConfirmAnswer = (approved: boolean) => {
    const request = thread?.pendingRequest;
    if (request && threadId) {
      post({ type: 'confirm_action', threadId, requestId: request.id, approved });
    }
  };

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
      setMeetingId(recording.id);
      setShowList(false);
      return;
    }
    const settings = await meetingSettingsStore.getSettings();
    // The first recording shows the reminder to tell participants
    if (!settings.consentShown) setConsent({ includeMic: settings.includeMic });
    else await startNotes(settings.includeMic);
  };

  const handleNewThread = () => {
    setMeetingId(null);
    setThreadId(null);
    setShowList(false);
    setBanner(null);
  };

  const handleSelect = (id: string) => {
    setMeetingId(null);
    setThreadId(id);
    setShowList(false);
    setBanner(null);
  };

  const handleDelete = (id: string) => {
    post({ type: 'thread_delete', threadId: id });
    if (id === threadId) setThreadId(null);
  };

  const handleBranch = async (index: number) => {
    const message = threadMessages[index];
    if (!threadId || !message) return;
    const fork = await threadStore.fork(threadId, message.seq);
    setThreadId(fork.id);
  };

  const handlePopOut = async () => {
    const url = chrome.runtime.getURL(`sidepanel.html${threadId ? `?thread=${threadId}` : ''}`);
    await chrome.windows.create({ url, type: 'popup', width: 440, height: 760 });
  };

  const messages: Message[] = useMemo(() => {
    const shown: Message[] = threadMessages.map(message => ({
      actor: message.actor as Actors,
      content: message.content,
      timestamp: message.ts,
    }));
    if (thread?.status === 'running' && thread.activity) {
      shown.push({
        actor: thread.activity === 'planning' ? Actors.PLANNER : Actors.NAVIGATOR,
        content: PROGRESS,
        timestamp: Date.now(),
      });
    }
    return shown;
  }, [threadMessages, thread?.status, thread?.activity]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, thread?.pendingRequest]);

  const headerButton = `header-icon ${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-400 hover:text-sky-500'} cursor-pointer`;

  const input = (
    <div className={`border-t ${isDarkMode ? 'border-sky-900' : 'border-sky-100'} p-2 shadow-sm backdrop-blur-sm`}>
      {thread?.pendingRequest && (
        <ConfirmCard request={thread.pendingRequest} onAnswer={handleConfirmAnswer} isDarkMode={isDarkMode} />
      )}
      {banner && (
        <div
          role="alert"
          className={`mb-2 rounded px-2 py-1 text-sm ${isDarkMode ? 'bg-red-950 text-red-200' : 'bg-red-50 text-red-700'}`}>
          {banner}
        </div>
      )}
      <ChatInput
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
        isDarkMode={isDarkMode}
      />
    </div>
  );

  return (
    <div>
      <div
        className={`flex h-screen flex-col ${isDarkMode ? 'bg-slate-900' : "bg-[url('/bg.jpg')] bg-cover bg-no-repeat"} overflow-hidden border ${isDarkMode ? 'border-sky-800' : 'border-[rgb(186,230,253)]'} rounded-2xl`}>
        <header className="header relative">
          <div className="header-logo min-w-0">
            <button
              type="button"
              onClick={() => setShowList(!showList)}
              className={`${headerButton} flex min-w-0 items-center gap-2`}
              aria-label={t('threads_list_title')}
              aria-expanded={showList}>
              <FiList size={20} className="shrink-0" />
              <span className={`truncate text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
                {showList ? t('threads_list_title') : thread?.title || t('threads_untitled')}
              </span>
            </button>
          </div>
          <div className="header-icons">
            <UsageBadge sessionId={threadId} isDarkMode={isDarkMode} />
            {recording ? (
              <button
                type="button"
                onClick={() => void handleTakeNotes()}
                className="flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-xs font-semibold text-white"
                aria-label={t('meeting_openNotes')}>
                <span className="inline-block size-2 animate-pulse rounded-full bg-white" />
                {t('meeting_recordingBadge', [clock(recordingFor)])}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleTakeNotes()}
                className={headerButton}
                aria-label={t('meeting_take')}
                title={t('meeting_take')}>
                <PiRecordBold size={20} />
              </button>
            )}
            {activeCount > 1 && (
              <button
                type="button"
                onClick={() => post({ type: 'thread_cancel_all' })}
                className="rounded bg-red-600 px-2 py-0.5 text-xs text-white">
                {t('threads_stopAll', [String(activeCount)])}
              </button>
            )}
            <button
              type="button"
              onClick={handleNewThread}
              className={headerButton}
              aria-label={t('threads_new')}
              title={t('threads_new')}>
              <PiPlusBold size={20} />
            </button>
            <button
              type="button"
              onClick={() => void handlePopOut()}
              className={headerButton}
              aria-label={t('threads_popOut')}
              title={t('threads_popOut')}>
              <FiExternalLink size={18} />
            </button>
            <button
              type="button"
              onClick={() => chrome.runtime.openOptionsPage()}
              className={headerButton}
              aria-label={t('nav_settings_a11y')}>
              <FiSettings size={20} />
            </button>
          </div>
        </header>

        {consent ? (
          <ConsentDialog
            includeMic={consent.includeMic}
            onStart={withMic => void startNotes(withMic)}
            onCancel={() => setConsent(null)}
            isDarkMode={isDarkMode}
          />
        ) : meetingId && !showList ? (
          <>
            {banner && (
              <div
                role="alert"
                className={`m-2 rounded px-2 py-1 text-sm ${isDarkMode ? 'bg-red-950 text-red-200' : 'bg-red-50 text-red-700'}`}>
                {banner}
              </div>
            )}
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
              isDarkMode={isDarkMode}
            />
          </>
        ) : showList ? (
          <div className="flex-1 overflow-hidden">
            <ThreadList
              activeThreadId={threadId}
              onSelect={handleSelect}
              onDelete={handleDelete}
              isDarkMode={isDarkMode}
            />
          </div>
        ) : hasConfiguredModels === null ? (
          <div
            className={`flex flex-1 items-center justify-center p-8 ${isDarkMode ? 'text-sky-300' : 'text-sky-600'}`}>
            <div className="text-center">
              <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent"></div>
              <p>{t('status_checkingConfig')}</p>
            </div>
          </div>
        ) : hasConfiguredModels === false ? (
          <div
            className={`flex flex-1 items-center justify-center p-8 ${isDarkMode ? 'text-sky-300' : 'text-sky-600'}`}>
            <div className="max-w-md text-center">
              <img src="/icon-128.png" alt="Avi Copilot Logo" className="mx-auto mb-4 size-12" />
              <h3 className={`mb-2 text-lg font-semibold ${isDarkMode ? 'text-sky-200' : 'text-sky-700'}`}>
                {t('welcome_title')}
              </h3>
              <p className="mb-4">{t('welcome_instruction')}</p>
              <button
                type="button"
                onClick={() => chrome.runtime.openOptionsPage()}
                className={`my-4 rounded-lg px-4 py-2 font-medium transition-colors ${
                  isDarkMode ? 'bg-sky-600 text-white hover:bg-sky-700' : 'bg-sky-500 text-white hover:bg-sky-600'
                }`}>
                {t('welcome_openSettings')}
              </button>
            </div>
          </div>
        ) : (
          <>
            {thread && (
              <ThreadBar
                thread={thread}
                onRebind={async () =>
                  post({ type: 'thread_rebind', threadId: thread.id, windowId: await currentWindowId() })
                }
                onContinue={async () =>
                  post({ type: 'thread_continue', threadId: thread.id, windowId: await currentWindowId() })
                }
                onOpenMeeting={thread.meetingId ? () => setMeetingId(thread.meetingId) : undefined}
                isDarkMode={isDarkMode}
              />
            )}
            {messages.length === 0 ? (
              <>
                {input}
                <div className="flex-1 overflow-y-auto">
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
                </div>
              </>
            ) : (
              <>
                <div
                  className={`scrollbar-gutter-stable flex-1 overflow-x-hidden overflow-y-scroll scroll-smooth p-2 ${isDarkMode ? 'bg-slate-900/80' : ''}`}>
                  <MessageList
                    messages={messages}
                    isDarkMode={isDarkMode}
                    onBranch={isBusy ? undefined : handleBranch}
                  />
                  <div ref={messagesEndRef} />
                </div>
                {input}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SidePanel;
