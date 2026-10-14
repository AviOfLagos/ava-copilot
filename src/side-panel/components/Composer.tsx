import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Mic, Paperclip, Play, Square, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { IMAGE_EXTENSIONS, IMAGE_TYPES, VIDEO_EXTENSIONS, VIDEO_TYPES, mediaTypeOf } from '@extension/storage';
import type { OutgoingAttachment } from '@extension/storage';
import { AttachmentReadError, readAttachment } from '../attachments/media';
import type { PendingAttachment } from '../attachments/media';
import type { SpeechInput } from '../hooks/useSpeechInput';
import { ListeningStrip } from './Dictation';
import './ui/morph-orb.css';

interface ComposerProps {
  // The words, and any pictures and videos attached
  onSendMessage: (text: string, attachments: OutgoingAttachment[]) => void;
  // A file that could not be attached, in a plain sentence
  onAttachProblem?: (message: string) => void;
  onStopTask: () => void;
  // Dictation: the mic button, and what is shown while it listens and writes the words down
  speech?: Pick<SpeechInput, 'status' | 'startedAt' | 'level' | 'toggle' | 'cancel'>;
  // Lets the panel hand over the words of a dictation when they are written down
  setTranscriptSink?: (sink: (words: string) => void) => void;
  disabled: boolean;
  showStopButton: boolean;
  setContent?: (setter: (text: string) => void) => void;
  placeholder?: string;
}

interface AttachedFile {
  name: string;
  content: string;
}

// Text files only, up to 1 MB each, as before
const ALLOWED = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.xml', '.yaml', '.yml'];
const MAX_FILE_BYTES = 1024 * 1024;
// Pictures and short videos, read in the panel and sent as images (see ../attachments/media.ts)
const MEDIA_ACCEPT = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...IMAGE_TYPES, ...VIDEO_TYPES];

/** What to tell the user about a file that could not be attached. */
function problemText(error: unknown, name: string): string {
  const problem = error instanceof AttachmentReadError ? error.problem : 'unreadable';
  switch (problem) {
    case 'type':
      return t('chat_attach_type');
    case 'imageTooBig':
      return t('chat_attach_imageTooBig');
    case 'videoTooBig':
      return t('chat_attach_videoTooBig');
    case 'videoTooLong':
      return t('chat_attach_videoTooLong');
    case 'tooMany':
      return t('chat_attach_tooMany');
    default:
      return t('chat_attach_unreadable', [name]);
  }
}
const MAX_HEIGHT = 132;

/** What was typed, then the dictated words after it. */
export function joinWords(typed: string, words: string): string {
  const spoken = words.trim();
  if (!spoken) return typed;
  const before = typed.trimEnd();
  return before ? `${before} ${spoken}` : spoken;
}

/**
 * The chat composer, in MorphOrb's typing style: a glass pill with a slow aurora, a lit ring that
 * quickens while you type, a spark, and a send button that lights up once there is something to send.
 */
export default function Composer({
  onSendMessage,
  onAttachProblem,
  onStopTask,
  speech,
  setTranscriptSink,
  disabled,
  showStopButton,
  setContent,
  placeholder,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [media, setMedia] = useState<PendingAttachment[]>([]);
  // Attachments still being read: sending waits for them
  const [reading, setReading] = useState(0);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  // Thumbnails are object URLs: let them go when the composer does
  useEffect(() => () => mediaRef.current.forEach(item => URL.revokeObjectURL(item.preview)), []);
  // Send pressed while dictating: the words go out as soon as they are written down
  const [sendWhenReady, setSendWhenReady] = useState(false);
  const sendWhenReadyRef = useRef(false);
  const textRef = useRef(text);
  textRef.current = text;
  const pillRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number>();

  const resize = () => {
    const area = textareaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, MAX_HEIGHT)}px`;
  };

  useEffect(() => {
    setContent?.(value => {
      setText(value);
      requestAnimationFrame(() => {
        resize();
        const area = textareaRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      });
    });
  }, [setContent]);

  useEffect(() => () => window.clearTimeout(typingTimer.current), []);

  const speechStatus = speech?.status ?? 'idle';
  const micOn = speechStatus === 'starting' || speechStatus === 'listening';
  const dictating = speechStatus !== 'idle';
  const ready = !disabled && reading === 0 && (text.trim().length > 0 || files.length > 0 || media.length > 0 || micOn);

  const waitToSend = (on: boolean) => {
    sendWhenReadyRef.current = on;
    setSendWhenReady(on);
  };

  // A dictation that ended without words (an error, a discard) sends nothing
  useEffect(() => {
    if (speechStatus === 'idle') waitToSend(false);
  }, [speechStatus]);

  // Esc drops a recording under way, wherever the focus is
  const cancelSpeech = speech?.cancel;
  useEffect(() => {
    if (!micOn || !cancelSpeech) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelSpeech();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [micOn, cancelSpeech]);

  const nudge = () => {
    const pill = pillRef.current;
    if (!pill) return;
    pill.removeAttribute('data-shake');
    void pill.offsetWidth;
    pill.setAttribute('data-shake', '');
    pill.setAttribute('data-flash', '');
    window.setTimeout(() => pill.removeAttribute('data-shake'), 260);
    window.setTimeout(() => pill.removeAttribute('data-flash'), 200);
  };

  /** Sends `value` with the attached files; false when there is nothing to send or sending is not possible now. */
  const sendText = useCallback(
    (value: string): boolean => {
      if (disabled || reading > 0) return false;
      const trimmed = value.trim();
      if (!trimmed && files.length === 0 && media.length === 0) {
        nudge();
        return false;
      }
      // File contents are tagged so the background can treat them as data
      const attached = files
        .map(file => `\n\n<nano_file_content type="file" name="${file.name}">\n${file.content}\n</nano_file_content>`)
        .join('\n');
      onSendMessage(
        attached ? `${trimmed}\n\n<nano_attached_files>${attached}</nano_attached_files>` : trimmed,
        media.map(item => item.outgoing),
      );
      setText('');
      setFiles([]);
      media.forEach(item => URL.revokeObjectURL(item.preview));
      setMedia([]);
      requestAnimationFrame(resize);
      return true;
    },
    [disabled, files, media, reading, onSendMessage],
  );
  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;

  const submit = useCallback(() => {
    if (speechStatus === 'listening') {
      // Finish listening; the words are sent once written down
      waitToSend(true);
      void speech?.toggle();
      return;
    }
    if (speechStatus === 'transcribing') {
      waitToSend(true);
      return;
    }
    // The microphone was still starting: nothing was said yet, so what is typed goes now
    if (speechStatus === 'starting') speech?.cancel();
    sendText(text);
  }, [speechStatus, speech, sendText, text]);

  // The words of a dictation: after what is typed, and sent at once when Send was pressed while dictating
  useEffect(() => {
    setTranscriptSink?.(words => {
      const joined = joinWords(textRef.current, words);
      if (sendWhenReadyRef.current) {
        waitToSend(false);
        if (sendTextRef.current(joined)) return;
      }
      setText(joined);
      requestAnimationFrame(() => {
        resize();
        const area = textareaRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      });
    });
  }, [setTranscriptSink]);

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    resize();
    const pill = pillRef.current;
    if (!pill) return;
    pill.setAttribute('data-typing', '');
    window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => pill.removeAttribute('data-typing'), 300);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    const read: AttachedFile[] = [];
    let attached = mediaRef.current.length;
    for (const file of picked) {
      const ext = `.${file.name.split('.').pop()?.toLowerCase()}`;
      if (mediaTypeOf(file.name, file.type)) {
        // Pictures and videos are read one at a time, each shown as soon as it is ready
        setReading(count => count + 1);
        try {
          const item = await readAttachment(file, attached);
          attached++;
          setMedia(previous => [...previous, item]);
        } catch (error) {
          onAttachProblem?.(problemText(error, file.name));
        } finally {
          setReading(count => count - 1);
        }
        continue;
      }
      if (!ALLOWED.includes(ext) || file.size > MAX_FILE_BYTES) {
        onAttachProblem?.(t('chat_attach_type'));
        continue;
      }
      try {
        read.push({ name: file.name, content: await file.text() });
      } catch {
        // An unreadable file is skipped
      }
    }
    setFiles(previous => [...previous, ...read]);
  };

  const removeMedia = (id: string) =>
    setMedia(previous => {
      const gone = previous.find(item => item.id === id);
      if (gone) URL.revokeObjectURL(gone.preview);
      return previous.filter(item => item.id !== id);
    });

  const iconButton =
    'flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40';

  return (
    <form
      aria-label={t('chat_input_form')}
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}>
      <div ref={pillRef} className="mo-pill" data-listening={micOn ? '' : undefined}>
        <div className="mo-underglow" aria-hidden="true" />
        <div className="mo-surface" aria-hidden="true">
          <div className="mo-aurora">
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="mo-ring" aria-hidden="true" />

        <div className="relative flex flex-col gap-1 p-2">
          {(media.length > 0 || reading > 0) && (
            <ul className="flex flex-wrap gap-1.5 px-2 pt-1" aria-label={t('chat_attach_media')}>
              {media.map(item => (
                <li key={item.id} className="relative">
                  <img
                    src={item.preview}
                    alt={
                      item.kind === 'video'
                        ? t('chat_attach_video', [item.name, String(Math.round(item.durationSec ?? 0))])
                        : item.name
                    }
                    title={item.name}
                    className="size-14 rounded-lg border object-cover"
                  />
                  {item.kind === 'video' && (
                    <span className="bg-background/80 absolute bottom-1 left-1 flex items-center gap-0.5 rounded px-1 font-mono text-[9.5px]">
                      <Play className="size-2.5 fill-current" aria-hidden="true" />
                      {Math.round(item.durationSec ?? 0)}s
                    </span>
                  )}
                  <button
                    type="button"
                    className="bg-background/90 hover:bg-accent absolute -right-1.5 -top-1.5 rounded-full border p-0.5"
                    aria-label={t('chat_input_removeFile', [item.name])}
                    title={t('chat_input_removeFile', [item.name])}
                    onClick={() => removeMedia(item.id)}>
                    <X className="size-3" />
                  </button>
                </li>
              ))}
              {reading > 0 && (
                <li
                  role="status"
                  aria-label={t('chat_attach_reading')}
                  className="flex size-14 items-center justify-center rounded-lg border border-dashed">
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                </li>
              )}
            </ul>
          )}
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 px-2 pt-1" aria-label={t('chat_input_attachments')}>
              {files.map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className="bg-secondary flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 font-mono text-[11px]">
                  {file.name}
                  <button
                    type="button"
                    className="hover:bg-accent rounded-full p-0.5"
                    aria-label={t('chat_input_removeFile', [file.name])}
                    onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))}>
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-end gap-1">
            <svg
              className="text-primary mb-2 ml-2 size-[18px] shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true">
              <path d="M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7L10 3.5z" />
              <path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
            </svg>
            {speech && speechStatus !== 'idle' ? (
              <ListeningStrip
                status={speechStatus}
                startedAt={speech.startedAt}
                level={speech.level}
                sendWhenReady={sendWhenReady}
                onCancel={speech.cancel}
              />
            ) : (
              <textarea
                ref={textareaRef}
                value={text}
                rows={1}
                disabled={disabled}
                placeholder={placeholder ?? t('chat_input_placeholder')}
                aria-label={t('chat_input_editor')}
                onChange={onChange}
                onKeyDown={onKeyDown}
                className="text-foreground placeholder:text-muted-foreground max-h-[132px] min-h-9 flex-1 resize-none border-0 bg-transparent p-2 text-[14px] leading-5 outline-none disabled:cursor-not-allowed"
              />
            )}
            <div className="flex shrink-0 items-center gap-0.5 pb-0.5">
              {!dictating && (
                <button
                  type="button"
                  className={iconButton}
                  onClick={() => fileRef.current?.click()}
                  disabled={disabled}
                  aria-label={t('chat_input_attach')}
                  title={t('chat_input_attach')}>
                  <Paperclip className="size-4" />
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={[...ALLOWED, ...MEDIA_ACCEPT].join(',')}
                className="hidden"
                onChange={event => void onFiles(event)}
              />
              {speech &&
                (micOn ? (
                  // While it listens, the mic is a stop button: the words then go in the box to edit
                  <button
                    type="button"
                    className="stt-stop"
                    onClick={() => void speech.toggle()}
                    aria-label={t('chat_stt_stop_insert')}
                    title={t('chat_stt_stop_insert')}>
                    <Square className="size-3 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={iconButton}
                    onClick={() => void speech.toggle()}
                    disabled={disabled || speechStatus === 'transcribing'}
                    aria-label={
                      speechStatus === 'transcribing' ? t('chat_stt_transcribing') : t('chat_stt_input_start')
                    }
                    title={speechStatus === 'transcribing' ? t('chat_stt_transcribing') : t('chat_stt_input_start')}>
                    <Mic className="size-4" />
                  </button>
                ))}
              {showStopButton ? (
                <button
                  type="button"
                  onClick={onStopTask}
                  aria-label={t('chat_buttons_stop')}
                  title={t('chat_buttons_stop')}
                  className="border-destructive/50 bg-destructive/15 text-foreground flex size-[38px] items-center justify-center rounded-full border">
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label={
                    sendWhenReady
                      ? t('chat_stt_sending_when_ready')
                      : dictating
                        ? t('chat_stt_send_when_ready')
                        : t('chat_buttons_send')
                  }
                  title={
                    sendWhenReady
                      ? t('chat_stt_sending_when_ready')
                      : dictating
                        ? t('chat_stt_send_when_ready')
                        : t('chat_buttons_send')
                  }
                  disabled={sendWhenReady}
                  data-ready={ready || dictating ? '' : undefined}
                  className="mo-send">
                  {sendWhenReady ? (
                    <Loader2 className="size-[18px] animate-spin" strokeWidth={1.75} />
                  ) : (
                    <ArrowUp className="size-[18px]" strokeWidth={1.75} />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
