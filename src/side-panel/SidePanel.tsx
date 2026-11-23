import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  AgentNameEnum,
  agentModelStore,
  db,
  LLM_PROVIDERS_STORAGE_KEY,
  llmProviderStore,
  providerIsUsable,
  meetingSettingsStore,
  threadStore,
  type KbAnswer,
  type KbCitation,
  type OutgoingAttachment,
  meetingStore,
  workspaceStore,
} from '@extension/storage';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import Composer from './components/Composer';
import type { DictationVocabulary, VocabularyApi } from './components/Composer';
import ConfirmCard from './components/ConfirmCard';
import BookmarkList from './components/BookmarkList';
import { Button } from './components/ui/button';
import { LiveOrb } from './components/ui/live-orb';
import { ThinkingOrb } from './components/ui/thinking-orb';
import ChatView from './chat/ChatView';
import Header from './layout/Header';
import Sidebar from './layout/Sidebar';
import type { Place } from './layout/Sidebar';
import type { Crumb } from './layout/Breadcrumbs';
import HelpView from './help/HelpView';
import MeetingsList from './meetings/MeetingsList';
import WorkspacePicker from './workspaces/WorkspacePicker';
import { syncVault } from './vault/vault';
import RouteBoundary from './components/RouteBoundary';
import { registeredPlace } from './registry';
import type { PanelApi } from './registry';
import './registers';
import { useAvaNavigation } from './capabilities/useAvaNavigation';
import { useTheme } from './layout/theme';
import HomeView from './home/HomeView';
import VoiceView from './voice/VoiceView';
import VoiceThreadBar from './voice/VoiceThreadBar';
import Onboarding from './onboarding/Onboarding';
import { useAssistantName } from './hooks/useAssistant';
import TodayView from './today/TodayView';
import SettingsView from './settings/SettingsView';
import { openSettingsPage } from '@src/shared/lib/settings-page';
import ThreadBar from './threads/ThreadBar';
import MeetingView, { clock, useElapsed } from './meetings/MeetingView';
import ConsentDialog from './meetings/ConsentDialog';
import AutoNotesCard from './meetings/AutoNotesCard';
import VoiceModelsCard from './voice-models/VoiceModelsCard';
import { ensureVoiceModels } from './voice-models/gate';
import KnowledgeView from './kb/KnowledgeView';
import TeachCard from './skills/TeachCard';
import { useLive } from './hooks/useLive';
import { useSpeechInput } from './hooks/useSpeechInput';
import { PendingSends } from './chat/pendingSends';
import UpdateBanner from './update/UpdateBanner';
import { PendingWorkspaceOffers } from './workspaces/MakeWorkspaceButton';
import { CallTaskCards } from './call-tasks/CallTaskCards';
import RecordingBar from './recordings/RecordingBar';
import WhatsNewCard from './update/WhatsNewCard';
import TabStart from './threads/TabStart';
import { loadUi, panelTabId, saveUi, useTabThread } from './threads/tabPanel';

// A thread tag: the user answered "Save as skill?" for this chat
const SKILL_OFFERED_TAG = 'skill:offered';

const HEARTBEAT_MS = 25_000;

// A popped-out panel opens on the thread named in its address
const threadFromUrl = () => new URLSearchParams(location.search).get('thread');
// The tab this panel belongs to: each tab has its own panel, with its own chat, draft and scroll (threads/tabPanel.ts)
const PANEL_TAB = panelTabId();

type PanelMessage =
  | { type: 'thread_started'; clientId: string; threadId: string }
  | { type: 'meeting_started'; clientId: string; meetingId: string }
  | { type: 'meeting_answer'; clientId: string; answer: string }
  | ({ type: 'kb_answer'; clientId: string } & KbAnswer)
  | { type: 'kb_saved'; clientId: string; title: string }
  | { type: 'skill_draft'; clientId: string; markdown: string }
  | {
      type: 'voice_started';
      ok: boolean;
      micDenied?: boolean;
      error?: string;
      cancelled?: boolean;
      threadId?: string;
    }
  | { type: 'voice_state'; status: 'off' | 'connecting' | 'listening' | 'speaking'; threadId: string | null }
  | { type: 'voice_text_sent'; clientId: string }
  | { type: 'error'; error: string; clientId?: string; threadId?: string | null }
  | {
      type: 'speech_to_text_result';
      text: string;
      changes?: DictationVocabulary['changes'];
      unsure?: DictationVocabulary['unsure'];
    }
  | { type: 'speech_to_text_error'; error: string; retryable?: boolean }
  | { type: 'heartbeat_ack' };

const SidePanel = () => {
  const { dark: isDarkMode } = useTheme();
  const assistantName = useAssistantName();
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null);
  // When the welcome screen last asked for the first-run model step
  const [setupAt, setSetupAt] = useState(0);
  const [threadId, setThreadId] = useState<string | null>(threadFromUrl);
  // Where the user is, and whether the menu (places and chat history) is open
  const [place, setPlace] = useState<Place>('chat');
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The workspace for the next new chat, picked on Home; none lets the chat's words choose
  const [nextWorkspace, setNextWorkspace] = useState<string | null>(null);
  // Where a chat goes when its words name no workspace: shown next to "auto" so it is no surprise
  const [defaultWorkspaceName, setDefaultWorkspaceName] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      void workspaceStore
        .getDefaultWorkspaceId()
        .then(id => workspaceStore.get(id))
        .then(workspace => setDefaultWorkspaceName(workspace?.name ?? null))
        .catch(() => setDefaultWorkspaceName(null));
    load();
    return workspaceStore.subscribe(load);
  }, []);
  // The meeting shown instead of a thread, and whether the recording reminder is up
  const [meetingId, setMeetingId] = useState<string | null>(null);
  // The voice screen was put away while the conversation goes on
  const [voiceHidden, setVoiceHidden] = useState(false);
  // When the user last ended the voice conversation
  const endedAtRef = useRef(0);
  const [savedSkillIn, setSavedSkillIn] = useState<string | null>(null);
  // Where a citation points in the meeting's transcript, in seconds
  const [meetingFocusT, setMeetingFocusT] = useState<number | null>(null);
  const [consent, setConsent] = useState<{ includeMic: boolean } | null>(null);
  // The spoken conversation, as the offscreen document reports it
  const [voiceStatus, setVoiceStatus] = useState<'off' | 'connecting' | 'listening' | 'speaking'>('off');
  // The chat the conversation is kept in: the Keyboard button opens it, and typing there goes to the conversation
  const [voiceThreadId, setVoiceThreadId] = useState<string | null>(null);
  // A problem to show above the input that belongs to no message, e.g. a send that was refused
  const [banner, setBanner] = useState<string | null>(null);
  // A short good-news line, e.g. a page saved
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatRef = useRef<number | null>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);
  // A starter a registered place asked for (PanelApi.startThread): delivered once the new chat's
  // composer has mounted, by the effect below — the composer is not mounted while on another place.
  const pendingPromptRef = useRef<string | null>(null);
  // Where a dictation's words go: the composer adds them after what is typed, or sends them
  const transcriptSinkRef = useRef<((words: string, vocabulary?: DictationVocabulary) => void) | null>(null);
  // Sends waiting to learn the id of the thread they created
  const pendingSendsRef = useRef(new Set<string>());
  // The words of every send the background has not taken yet: they go back in the composer if it refuses
  const unconfirmedRef = useRef(new PendingSends());
  // Dictation that could not be written down; its recording is kept and the alert offers to try again
  const [sttError, setSttError] = useState<string | null>(null);
  // Questions about a meeting waiting for their answer
  const pendingAsksRef = useRef(new Map<string, () => void>());
  // Requests from registered places waiting for their reply
  const pendingRequestsRef = useRef(
    new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>(),
  );
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
  // Whether the meeting has taken anything down yet: until it has, the header does not pulse "recording"
  const recordingWords = useLive(
    () => (recording ? db.segments.where('meetingId').equals(recording.id).count() : Promise.resolve(0)),
    [recording?.id],
    0,
  );

  const isBusy = thread?.status === 'running' || thread?.status === 'waiting_confirm';
  // After a browsing task that worked, offer once to save what it learned as a skill
  const canTeach =
    thread?.status === 'idle' &&
    !thread.error &&
    !thread.meetingId &&
    // Never in a chat an agent, a routine or the brief ran (background/skills/teach.ts#canTeachFrom)
    !['agent', 'workflow', 'brief'].includes(thread.origin ?? '') &&
    !thread.tags.includes(SKILL_OFFERED_TAG) &&
    threadMessages.some(message => message.actor === 'navigator') &&
    threadMessages.at(-1)?.actor === 'planner';

  // A task cannot run without a Navigator model whose provider has an API key
  const checkModelConfiguration = useCallback(async () => {
    try {
      const navigatorModel = await agentModelStore.getAgentModel(AgentNameEnum.Navigator);
      const provider = navigatorModel ? await llmProviderStore.getProvider(navigatorModel.provider) : undefined;
      // Local servers (Ollama, LM Studio) and custom OpenAI-compatible providers can run without a key
      setHasConfiguredModels(!!navigatorModel && providerIsUsable(provider, navigatorModel.provider));
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
    // A model set up anywhere (the first-run setup, Models & usage) makes the panel ready at once
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes['agent-models'] || changes[LLM_PROVIDERS_STORAGE_KEY])) {
        void checkModelConfiguration();
      }
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, [checkModelConfiguration]);

  useEffect(() => {
    favoritesStorage
      .getAllPrompts()
      .then(setFavoritePrompts)
      .catch(error => console.error('Failed to load favorite prompts:', error));
  }, []);

  // The workspace the chat box writes in, for the vocabulary that applies there before a chat exists
  const composerWorkspaceRef = useRef<string | null>(null);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const speech = useSpeechInput(
    useCallback(audio => {
      setSttError(null);
      postRef.current({
        type: 'speech_to_text',
        audio,
        threadId: threadIdRef.current,
        workspaceId: composerWorkspaceRef.current,
      });
    }, []),
    useCallback((message: string, retryable?: boolean) => (retryable ? setSttError(message) : setBanner(message)), []),
    // While dictating, a voice conversation and "Hey Ava" do not hear the microphone, so the words are answered once
    useCallback((on: boolean) => postRef.current({ type: 'dictation_hold', on }), []),
  );
  const { done: speechDone, status: speechStatus } = speech;
  const speechStatusRef = useRef(speechStatus);
  speechStatusRef.current = speechStatus;

  /** Puts the words of a send that did not go through back in the composer, and says so. */
  const keepUnsent = useCallback((text: string | null, why?: string) => {
    if (text === null) {
      if (why) setBanner(why);
      return;
    }
    setInputTextRef.current?.(text);
    setBanner([why, t('chat_send_kept')].filter(Boolean).join(' '));
  }, []);
  const setTranscriptSink = useCallback((sink: (words: string, vocabulary?: DictationVocabulary) => void) => {
    transcriptSinkRef.current = sink;
  }, []);

  const onPortMessage = useCallback(
    (message: PanelMessage) => {
      // A reply to a registered feature's request: it goes to whoever asked, nowhere else
      const requestId = (message as { requestId?: unknown }).requestId;
      if (typeof requestId === 'string' && pendingRequestsRef.current.has(requestId)) {
        const pending = pendingRequestsRef.current.get(requestId)!;
        pendingRequestsRef.current.delete(requestId);
        if (message.type === 'error') {
          pending.reject(new Error((message as { error?: string }).error || t('errors_unknown')));
        } else {
          pending.resolve(message as unknown as Record<string, unknown>);
        }
        return;
      }
      switch (message.type) {
        case 'thread_started':
          unconfirmedRef.current.confirm(message.clientId);
          if (pendingSendsRef.current.delete(message.clientId)) {
            setThreadId(message.threadId);
            setSending(false);
          }
          break;
        case 'meeting_started':
          setPlace('meetings');
          setMeetingId(message.meetingId);
          setDrawerOpen(false);
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
          } else if (message.cancelled) {
            // The user ended it while it was starting: nothing to say
            setVoiceStatus('off');
          } else if (!message.ok) {
            setVoiceStatus('off');
            setBanner(message.error || t('errors_unknown'));
          } else if (message.threadId) {
            setVoiceThreadId(message.threadId);
          }
          break;
        case 'voice_state':
          // The panel opened while a conversation was on
          if (message.threadId) setVoiceThreadId(message.threadId);
          if (message.status !== 'off') setVoiceStatus(message.status);
          break;
        case 'voice_text_sent':
          unconfirmedRef.current.confirm(message.clientId);
          setSending(false);
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
          // A refused send keeps its words: they go back in the composer
          keepUnsent(unconfirmedRef.current.fail(message.clientId), message.error || t('errors_unknown'));
          break;
        case 'speech_to_text_result':
          setSttError(null);
          transcriptSinkRef.current?.(message.text ?? '', {
            changes: message.changes ?? [],
            unsure: message.unsure ?? [],
          });
          speechDone(true);
          break;
        case 'speech_to_text_error':
          // The recording is kept; the alert offers to write it down again
          speechDone(false);
          if (message.retryable) setSttError(message.error || t('chat_stt_unanswered'));
          else setBanner(message.error || t('chat_stt_recognitionFailed'));
          break;
      }
    },
    [speechDone, keepUnsent],
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
      // The background restarted: what it was given and did not answer is not lost
      keepUnsent(unconfirmedRef.current.failAll());
      if (pendingSendsRef.current.size) {
        pendingSendsRef.current.clear();
        setSending(false);
      }
      if (speechStatusRef.current === 'transcribing') {
        speechDone(false);
        setSttError(t('chat_stt_unanswered'));
      }
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
  }, [onPortMessage, keepUnsent, speechDone]);

  const post = useCallback((message: Record<string, unknown>) => connect().postMessage(message), [connect]);

  // What registered places use to reach the background: requests carry an id, and give up after a while
  const panelApi: PanelApi = {
    go: next => (next === 'chat' ? handleNewThread() : go(next as Place)),
    openThread: id => handleSelect(id),
    startThread: prompt => handleStartThread(prompt),
    post,
    request: <T,>(message: Record<string, unknown>, timeoutMs = 30_000) =>
      new Promise<T>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = window.setTimeout(() => {
          pendingRequestsRef.current.delete(requestId);
          reject(new Error(t('errors_timeout')));
        }, timeoutMs);
        pendingRequestsRef.current.set(requestId, {
          resolve: value => {
            window.clearTimeout(timer);
            resolve(value as T);
          },
          reject: error => {
            window.clearTimeout(timer);
            reject(error);
          },
        });
        try {
          post({ ...message, requestId });
        } catch (error) {
          window.clearTimeout(timer);
          pendingRequestsRef.current.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }),
  };
  // Dictation that would be written down on the device offers the speech files' download before it listens
  const gatedSpeech = {
    ...speech,
    toggle: async () => {
      if (speech.status === 'idle' && !(await ensureVoiceModels('dictation', panelApi.request))) return;
      await speech.toggle();
    },
  };
  // Ava opens places and Settings sections here (open_place); the voice screen steps aside to show them
  useAvaNavigation({
    go: next => panelApi.go(next),
    openThread: id => panelApi.openThread(id),
    assistantName,
    onOpened: text => {
      setVoiceHidden(true);
      if (text) setNotice(text);
    },
  });
  const postRef = useRef(post);
  postRef.current = post;

  useEffect(() => {
    connect();
    // Whether a conversation is on already, and in which chat
    post({ type: 'voice_state' });
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [connect, post]);

  const currentWindowId = async () => (await chrome.windows.getCurrent()).id;

  // The chat on screen holds the conversation that is on: what is typed there goes to it
  const voiceLiveHere = voiceStatus !== 'off' && !!threadId && threadId === voiceThreadId;

  const handleSend = async (text: string, attachments: OutgoingAttachment[] = []) => {
    const trimmed = text.trim();
    // The words as typed or dictated, without the attached files' contents: what goes back in the box if refused
    const words = trimmed.replace(/\s*<nano_attached_files>[\s\S]*<\/nano_attached_files>$/, '');
    if (!trimmed && attachments.length === 0) return;
    if (isBusy || sending) {
      keepUnsent(words || null);
      return;
    }
    setBanner(null);
    const clientId = crypto.randomUUID();
    unconfirmedRef.current.add(clientId, words);
    if (voiceLiveHere) {
      setSending(true);
      try {
        post({ type: 'voice_text', clientId, threadId, text: trimmed, attachments });
      } catch (error) {
        setSending(false);
        keepUnsent(unconfirmedRef.current.fail(clientId), error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!threadId) {
      // A new thread gets its id from the background; until then the input waits
      pendingSendsRef.current.add(clientId);
      setSending(true);
    }
    try {
      post({
        type: 'thread_send',
        clientId,
        threadId,
        text: trimmed,
        attachments,
        windowId: await currentWindowId(),
        // The tab this panel belongs to: a new chat lives there
        tabId: PANEL_TAB ?? undefined,
        // A new chat goes to the workspace picked on Home; otherwise its words choose one
        workspaceId: threadId ? null : nextWorkspace,
      });
    } catch (error) {
      pendingSendsRef.current.delete(clientId);
      setSending(false);
      keepUnsent(unconfirmedRef.current.fail(clientId), error instanceof Error ? error.message : String(error));
    }
  };

  const handleStop = () => threadId && post({ type: 'thread_cancel', threadId });

  const handleConfirmAnswer = (approved: boolean, replies?: string[], always?: boolean) => {
    const request = thread?.pendingRequest;
    if (request && threadId) {
      post({ type: 'confirm_action', threadId, requestId: request.id, approved, replies, always: always === true });
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
      openMeeting(recording.id);
      return;
    }
    const settings = await meetingSettingsStore.getSettings();
    // The first recording shows the reminder to tell participants
    if (!settings.consentShown) setConsent({ includeMic: settings.includeMic });
    else await startNotes(settings.includeMic);
  };

  // The offscreen document tells every page how the conversation is going
  useEffect(() => {
    const onStatus = (message: {
      type?: string;
      status?: typeof voiceStatus;
      error?: string;
      threadId?: string | null;
    }) => {
      if (message?.type !== 'voice_status' || !message.status) return;
      // Right after the user ended the conversation, a late "listening" must not bring the screen back
      if (message.status !== 'off' && Date.now() - endedAtRef.current < 4000) return;
      setVoiceStatus(message.status);
      if (message.threadId) setVoiceThreadId(message.threadId);
      if (message.error) setBanner(message.error);
    };
    chrome.runtime.onMessage.addListener(onStatus);
    return () => chrome.runtime.onMessage.removeListener(onStatus);
  }, []);

  const toggleVoice = async () => {
    setBanner(null);
    if (voiceStatus !== 'off') {
      endedAtRef.current = Date.now();
      setVoiceStatus('off');
      post({ type: 'voice_stop' });
      return;
    }
    endedAtRef.current = 0;
    // On the device and its speech files not downloaded yet: the download card first, then the conversation
    if (!(await ensureVoiceModels('talk', panelApi.request))) return;
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
    if (anchor.kind === 'note' || anchor.kind === 'ambient') {
      // A note, or what Ava heard, lives in memory itself
      go('memory');
    } else if (anchor.kind === 'page') {
      void chrome.tabs.create({ url: anchor.url });
    } else if (anchor.kind === 'meeting') {
      openMeeting(anchor.meetingId, anchor.t);
    } else {
      handleSelect(anchor.threadId);
    }
  };

  /** Goes to a place in the copilot; the menu closes behind it. */
  const go = (next: Place) => {
    setPlace(next);
    setMeetingId(null);
    setMeetingFocusT(null);
    setDrawerOpen(false);
    setBanner(null);
  };

  /** Opens one meeting, at a moment of its transcript when one is given. */
  const openMeeting = (id: string, focusT: number | null = null) => {
    go('meetings');
    setMeetingId(id);
    setMeetingFocusT(focusT);
  };

  const handleNewThread = () => {
    go('chat');
    setThreadId(null);
    // This tab lets go of its chat: opening Ava here again starts fresh
    if (PANEL_TAB !== null) post({ type: 'tab_panel_clear', tabId: PANEL_TAB });
  };

  /** A new chat, with `prompt` placed in the composer once it mounts (see the effect below `view`). */
  const handleStartThread = (prompt: string) => {
    pendingPromptRef.current = prompt;
    handleNewThread();
  };

  const showThread = (id: string) => {
    go('chat');
    setThreadId(id);
  };

  /** Opens a chat in this panel. A tab's panel makes it the tab's chat, and says when it cannot act here yet. */
  const handleSelect = (id: string) => {
    showThread(id);
    if (PANEL_TAB === null) return;
    void panelApi
      .request<{ state: 'ok' | 'running_elsewhere' | 'tab_busy'; holderTitle?: string }>({
        type: 'tab_panel_open',
        tabId: PANEL_TAB,
        threadId: id,
      })
      .then(reply => {
        if (reply.state === 'tab_busy') setBanner(t('tabPanel_busyHere', [reply.holderTitle ?? '']));
        else if (reply.state === 'running_elsewhere') setBanner(t('tabPanel_runningElsewhere'));
      })
      .catch(error => setBanner(error instanceof Error ? error.message : String(error)));
  };

  // The chat of this tab: shown on opening, and followed when it moves to another tab or is deleted
  useTabThread(PANEL_TAB, threadId, change => {
    if (change.kind === 'show') {
      showThread(change.threadId);
      return;
    }
    setThreadId(null);
    if (change.kind === 'moved') setBanner(t('tabPanel_moved'));
  });

  const handleDelete = (id: string) => {
    post({ type: 'thread_delete', threadId: id });
    if (id === threadId) setThreadId(null);
  };

  // A chat the background asked to show, e.g. the morning brief after its notification was clicked
  useEffect(() => {
    void chrome.storage.session.get('open-thread').then(stored => {
      const id = stored['open-thread'];
      if (typeof id !== 'string') return;
      void chrome.storage.session.remove('open-thread');
      handleSelect(id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The Obsidian vault, when one is connected: synced on opening and every 10 minutes while open
  useEffect(() => {
    const sync = () => void syncVault().catch(error => console.warn('Vault sync failed', error));
    sync();
    const timer = window.setInterval(sync, 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Good news fades on its own
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleBranch = async (seq: number) => {
    if (!threadId) return;
    const fork = await threadStore.fork(threadId, seq);
    handleSelect(fork.id);
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

  const view:
    | 'consent'
    | 'registered'
    | 'settings'
    | 'kb'
    | 'today'
    | 'help'
    | 'meetings'
    | 'meeting'
    | 'checking'
    | 'welcome'
    | 'chat'
    | 'home' = consent
    ? 'consent'
    : registeredPlace(place)
      ? 'registered'
      : place === 'settings'
        ? 'settings'
        : place === 'today'
          ? 'today'
          : place === 'memory'
            ? 'kb'
            : place === 'help'
              ? 'help'
              : place === 'meetings'
                ? meetingId
                  ? 'meeting'
                  : 'meetings'
                : hasConfiguredModels === null
                  ? 'checking'
                  : hasConfiguredModels === false
                    ? 'welcome'
                    : thread && (threadMessages.length > 0 || thread.id === voiceThreadId)
                      ? 'chat'
                      : 'home';

  // Delivers a starter from handleStartThread once the new chat's home view (and its composer) is up:
  // Composer's own [setContent] effect runs first (children commit before parents), so the ref is live.
  useEffect(() => {
    if (view !== 'home' || !pendingPromptRef.current) return;
    const prompt = pendingPromptRef.current;
    pendingPromptRef.current = null;
    setInputTextRef.current?.(prompt);
  }, [view]);

  // What this tab's panel was showing: the draft in the box and where the chat was scrolled to, kept so coming back
  // to the tab finds it as it was, even when Chrome made the panel anew
  const draftRef = useRef('');
  const uiRef = useRef<{ draft: string; scroll: number | null }>({ draft: '', scroll: null });
  const uiTimer = useRef<number | undefined>(undefined);
  const saveUiSoon = useCallback(() => {
    if (PANEL_TAB === null) return;
    window.clearTimeout(uiTimer.current);
    uiTimer.current = window.setTimeout(() => void saveUi(PANEL_TAB, uiRef.current).catch(() => {}), 300);
  }, []);
  const rememberDraft = useCallback(
    (text: string) => {
      draftRef.current = text;
      if (uiRef.current.draft === text) return;
      uiRef.current = { ...uiRef.current, draft: text };
      saveUiSoon();
    },
    [saveUiSoon],
  );
  const [restoredUi, setRestoredUi] = useState(PANEL_TAB === null);
  useEffect(() => {
    if (PANEL_TAB === null || restoredUi || (view !== 'home' && view !== 'chat')) return;
    setRestoredUi(true);
    void loadUi(PANEL_TAB).then(ui => {
      if (!ui) return;
      uiRef.current = ui;
      // Kept for the box when it mounts again (home and chat each have their own), and put in the one shown now
      draftRef.current = ui.draft;
      if (ui.draft) setInputTextRef.current?.(ui.draft);
      if (ui.scroll === null) return;
      // After the chat has laid out and stuck to the bottom once
      window.setTimeout(() => {
        const scroller = document.querySelector<HTMLElement>('[role="log"] > div');
        if (scroller) scroller.scrollTop = ui.scroll!;
      }, 600);
    });
  }, [view, restoredUi]);
  useEffect(() => {
    if (PANEL_TAB === null || view !== 'chat') return;
    const scroller = document.querySelector<HTMLElement>('[role="log"] > div');
    if (!scroller) return;
    const onScroll = () => {
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
      uiRef.current = { ...uiRef.current, scroll: atBottom ? null : Math.round(scroller.scrollTop) };
      saveUiSoon();
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [view, threadId, saveUiSoon]);

  // Where you are, each step back one click away
  const home: Crumb = { label: t('nav_home'), onClick: handleNewThread };
  const openedMeeting = useLive(
    () => (meetingId ? meetingStore.get(meetingId) : Promise.resolve(undefined)),
    [meetingId],
    undefined,
  );
  const crumbs: Crumb[] =
    view === 'chat'
      ? [
          home,
          { label: t('nav_chats'), onClick: () => setDrawerOpen(true) },
          { label: thread?.title || t('threads_untitled') },
        ]
      : view === 'meeting'
        ? [
            home,
            { label: t('nav_meetings'), onClick: () => go('meetings') },
            {
              label:
                openedMeeting?.note?.title || openedMeeting?.topic || openedMeeting?.title || t('threads_untitled'),
            },
          ]
        : view === 'meetings'
          ? [home, { label: t('nav_meetings') }]
          : view === 'kb'
            ? [home, { label: t('kb_title') }]
            : view === 'today'
              ? [home, { label: t('today_title') }]
              : view === 'settings'
                ? [home, { label: t('settings_title') }]
                : view === 'help'
                  ? [home, { label: t('nav_help') }]
                  : view === 'registered'
                    ? [home, { label: t(registeredPlace(place)!.label) }]
                    : [{ label: t('nav_home') }];

  const alerts = (
    <>
      {banner && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 mb-2 rounded-xl border px-3 py-2 text-[12.5px]">
          {banner}
        </div>
      )}
      {sttError && (
        <div
          role="alert"
          data-testid="stt-error"
          className="border-destructive/40 bg-destructive/10 mb-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1">{sttError}</span>
          {speech.canRetry && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setSttError(null);
                speech.retry();
              }}>
              {t('chat_stt_retry')}
            </Button>
          )}
        </div>
      )}
      {notice && (
        <div role="status" className="border-primary/40 bg-primary/10 mb-2 rounded-xl border px-3 py-2 text-[12.5px]">
          {notice}
        </div>
      )}
    </>
  );

  // What the composer asks of the vocabulary: learn a correction, and never change a word again
  const composerWorkspace = view === 'chat' && threadId ? (thread?.workspaceId ?? null) : nextWorkspace;
  composerWorkspaceRef.current = composerWorkspace;
  const composerVocabulary: VocabularyApi = {
    learn: async (from, to, confirmed) => {
      const reply = await panelApi.request<{ saved?: boolean; automatic?: boolean }>({
        type: 'vocab_learn',
        from,
        to,
        confirmed,
        workspaceId: composerWorkspace,
      });
      return { saved: reply.saved === true, automatic: reply.automatic === true };
    },
    never: async word => {
      await panelApi.request({ type: 'vocab_never', word });
    },
  };

  const composer = (
    <div className="shrink-0 px-2.5 pb-2.5 pt-1">
      {thread?.pendingRequest && view === 'chat' && (
        <ConfirmCard request={thread.pendingRequest} onAnswer={handleConfirmAnswer} isDarkMode={isDarkMode} />
      )}
      {alerts}
      <Composer
        onSendMessage={(text, attachments) => void handleSend(text, attachments)}
        onAttachProblem={message => setBanner(message)}
        onStopTask={handleStop}
        speech={gatedSpeech}
        setTranscriptSink={setTranscriptSink}
        vocabulary={composerVocabulary}
        disabled={isBusy || sending}
        showStopButton={isBusy}
        setContent={setter => {
          setInputTextRef.current = setter;
        }}
        onTextChange={rememberDraft}
        initialText={draftRef.current}
      />
      <p className="text-muted-foreground mt-1.5 text-center text-[10.5px]">
        {speech.status === 'starting' || speech.status === 'listening' ? t('chat_stt_hint') : t('chat_footer_gate')}
      </p>
    </div>
  );

  return (
    <div className="aura text-foreground relative flex h-screen flex-col overflow-hidden font-sans">
      <Onboarding
        hasModel={hasConfiguredModels}
        request={panelApi.request}
        onOpenModels={() => go('models' as Place)}
        reopenAt={setupAt}
        hideResume={view === 'welcome'}
      />
      {voiceStatus !== 'off' && !voiceHidden && (
        <VoiceView
          status={voiceStatus}
          onEnd={() => void toggleVoice()}
          onHide={() => {
            // The keyboard opens the conversation's own chat, not whatever was on screen; the voice stays on
            setVoiceHidden(true);
            if (voiceThreadId) handleSelect(voiceThreadId);
          }}
        />
      )}
      <Sidebar
        open={drawerOpen}
        place={place}
        inChat={view === 'chat'}
        activeThreadId={threadId}
        onClose={() => setDrawerOpen(false)}
        onGo={next => (next === 'chat' ? handleNewThread() : go(next))}
        onNewChat={handleNewThread}
        onSelect={handleSelect}
        onDelete={handleDelete}
        onPopOut={() => void handlePopOut()}
      />
      <Header
        crumbs={crumbs}
        menuOpen={drawerOpen}
        onMenu={() => setDrawerOpen(!drawerOpen)}
        busy={activeCount > 0 || voiceStatus !== 'off'}
        recordingLabel={recording ? clock(recordingFor) : null}
        recordingIdle={recordingWords === 0}
        onNotes={() => void handleTakeNotes()}
        voiceStatus={voiceStatus}
        // A hidden conversation comes back to the front; otherwise the button starts or ends it
        onVoice={() => (voiceStatus !== 'off' && voiceHidden ? setVoiceHidden(false) : void toggleVoice())}
        onNewThread={handleNewThread}
        activeCount={activeCount}
        onStopAll={() => post({ type: 'thread_cancel_all' })}
        workspaceId={view === 'chat' && threadId ? (thread?.workspaceId ?? null) : nextWorkspace}
        onPersonalities={() => void openSettingsPage('#personalities')}
      />

      {/* A screen recording's red mark, timer and Stop, on every page of the panel */}
      <RecordingBar />
      {(view === 'home' || view === 'chat') && <WhatsNewCard api={panelApi} />}
      {(view === 'home' || view === 'chat') && <UpdateBanner api={panelApi} />}
      {/* A workspace made by voice: its Undo, and the sheet for what looks like it (docs/pm-desk.md, Part 3) */}
      <PendingWorkspaceOffers />
      {/* On a call: whether a spoken task is heard, and a card per task just said (docs/pm-desk.md Part 6) */}
      <CallTaskCards />

      {elsewhere?.pendingRequest && (
        <div className="px-2.5 pt-2">
          <p className="text-muted-foreground mb-1 text-[11.5px]">
            {t('threads_waitingElsewhere', [elsewhere.title || t('threads_untitled')])}
          </p>
          <ConfirmCard
            request={elsewhere.pendingRequest}
            onAnswer={(approved, replies, always) =>
              post({
                type: 'confirm_action',
                threadId: elsewhere.id,
                requestId: elsewhere.pendingRequest!.id,
                approved,
                replies,
                always: always === true,
              })
            }
            isDarkMode={isDarkMode}
          />
        </div>
      )}

      <AutoNotesCard
        recording={recording}
        api={panelApi}
        onOpen={id => openMeeting(id)}
        viewing={view === 'meeting' ? meetingId : null}
      />
      <VoiceModelsCard />

      {view === 'consent' && consent && (
        <ConsentDialog
          includeMic={consent.includeMic}
          onStart={withMic => void startNotes(withMic)}
          onCancel={() => setConsent(null)}
          isDarkMode={isDarkMode}
        />
      )}

      {view === 'kb' && (
        <KnowledgeView
          onAsk={(question, workspaceId, agentId) =>
            kbRequest<KbAnswer>({ type: 'kb_ask', question, workspaceId, agentId })
          }
          onSavePage={async (workspaceId, agentId) =>
            kbRequest<string>({ type: 'kb_save_page', windowId: await currentWindowId(), workspaceId, agentId })
          }
          onDelete={itemId => post({ type: 'kb_delete', itemId })}
          onOpenCitation={openCitation}
          onOpenSource={node => {
            // A source node's id is its knowledge item's: "<type>:<source id>"
            const sourceId = node.id.slice(node.type.length + 1);
            if (node.type === 'thread') handleSelect(sourceId);
            else if (node.type === 'meeting') openMeeting(sourceId);
            else if (node.type === 'page' && /^https?:/.test(sourceId)) void chrome.tabs.create({ url: sourceId });
          }}
          isDarkMode={isDarkMode}
        />
      )}

      {view === 'settings' && <SettingsView onBack={handleNewThread} onOpenThread={handleSelect} api={panelApi} />}

      {view === 'help' && <HelpView onGo={next => (next === 'chat' ? handleNewThread() : go(next))} />}

      {view === 'registered' &&
        (() => {
          const { Component } = registeredPlace(place)!;
          return (
            <RouteBoundary key={place}>
              <Component api={panelApi} />
            </RouteBoundary>
          );
        })()}

      {view === 'meetings' && (
        <MeetingsList
          onOpen={id => openMeeting(id)}
          onTakeNotes={() => void handleTakeNotes()}
          recordingId={recording?.id ?? null}
        />
      )}

      {view === 'today' && (
        <>
          <div className="px-3 pt-2">
            <Button variant="ghost" size="sm" onClick={handleNewThread}>
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
          <LiveOrb size={132} label={assistantName} />
          <div className="space-y-2">
            <h3 className="text-lg font-medium tracking-tight">{t('welcome_title')}</h3>
            <p className="text-muted-foreground text-sm">{t('onboard_welcome_body')}</p>
          </div>
          <Button size="lg" onClick={() => setSetupAt(Date.now())}>
            {t('onboard_welcome_button')}
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
            onOpenMeeting={thread.meetingId ? () => openMeeting(thread.meetingId!) : undefined}
            onWorkspace={workspaceId => post({ type: 'thread_workspace', threadId: thread.id, workspaceId })}
            onAutoMode={on => post({ type: 'thread_auto_mode', threadId: thread.id, on })}
            onRetry={async () => post({ type: 'thread_retry', threadId: thread.id, windowId: await currentWindowId() })}
            onStopRetry={() => post({ type: 'thread_cancel', threadId: thread.id })}
            isDarkMode={isDarkMode}
            api={panelApi}
          />
          {thread.tags.includes('voice') && (
            <VoiceThreadBar
              threadId={thread.id}
              live={voiceLiveHere}
              onBackToVoice={() => setVoiceHidden(false)}
              onOpenThread={handleSelect}
            />
          )}
          <ChatView
            thread={thread}
            messages={threadMessages}
            onBranch={isBusy ? undefined : seq => void handleBranch(seq)}
            onRetry={isBusy ? undefined : () => post({ type: 'thread_retry', threadId: thread.id })}
            onRetryFrom={
              isBusy
                ? undefined
                : seq =>
                    void (async () => {
                      try {
                        const reply = await panelApi.request<{ threadId: string }>({
                          type: 'thread_retry_from',
                          threadId: thread.id,
                          seq,
                          windowId: await currentWindowId(),
                        });
                        handleSelect(reply.threadId);
                      } catch (error) {
                        setBanner(error instanceof Error ? error.message : String(error));
                      }
                    })()
            }
            onSpeak={(threadId, messageId, text) => post({ type: 'speak_say', threadId, messageId, text })}
            onStopSpeaking={() => post({ type: 'speak_stop' })}
            api={panelApi}
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
            {PANEL_TAB !== null && (
              <TabStart onNew={() => setInputTextRef.current?.(draftRef.current)} onOpen={handleSelect} />
            )}
            <HomeView
              workspaceId={nextWorkspace}
              onPrompt={text => setInputTextRef.current?.(text)}
              onOpenKb={() => go('memory')}
              onTakeNotes={() => void handleTakeNotes()}
              onSavePage={() => void savePage()}
              onOpenToday={() => go('today')}
              onOpenThread={handleSelect}>
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
          <div className="flex shrink-0 justify-center px-2.5">
            <WorkspacePicker
              value={nextWorkspace}
              onChange={setNextWorkspace}
              emptyLabel={
                defaultWorkspaceName ? `${t('workspace_auto')} · ${defaultWorkspaceName}` : t('workspace_auto')
              }
              className="max-w-[60%]"
            />
          </div>
          {composer}
        </>
      )}
    </div>
  );
};

export default SidePanel;
