import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Mic, Paperclip, Square, X } from 'lucide-react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import './ui/morph-orb.css';

interface ComposerProps {
  onSendMessage: (text: string) => void;
  onStopTask: () => void;
  onMicClick?: () => void;
  isRecording?: boolean;
  isProcessingSpeech?: boolean;
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
const MAX_HEIGHT = 132;

/**
 * The chat composer, in MorphOrb's typing style: a glass pill with a slow aurora, a lit ring that
 * quickens while you type, a spark, and a send button that lights up once there is something to send.
 */
export default function Composer({
  onSendMessage,
  onStopTask,
  onMicClick,
  isRecording = false,
  isProcessingSpeech = false,
  disabled,
  showStopButton,
  setContent,
  placeholder,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
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
      requestAnimationFrame(resize);
    });
  }, [setContent]);

  useEffect(() => () => window.clearTimeout(typingTimer.current), []);

  const ready = !disabled && (text.trim().length > 0 || files.length > 0);

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

  const submit = useCallback(() => {
    if (disabled) return;
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) {
      nudge();
      return;
    }
    // File contents are tagged so the background can treat them as data
    const attached = files
      .map(file => `\n\n<nano_file_content type="file" name="${file.name}">\n${file.content}\n</nano_file_content>`)
      .join('\n');
    onSendMessage(attached ? `${trimmed}\n\n<nano_attached_files>${attached}</nano_attached_files>` : trimmed);
    setText('');
    setFiles([]);
    requestAnimationFrame(resize);
  }, [disabled, text, files, onSendMessage]);

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
    const read: AttachedFile[] = [];
    for (const file of picked) {
      const ext = `.${file.name.split('.').pop()?.toLowerCase()}`;
      if (!ALLOWED.includes(ext) || file.size > MAX_FILE_BYTES) continue;
      try {
        read.push({ name: file.name, content: await file.text() });
      } catch {
        // An unreadable file is skipped
      }
    }
    setFiles(previous => [...previous, ...read]);
    event.target.value = '';
  };

  const iconButton =
    'flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40';

  return (
    <form
      aria-label={t('chat_input_form')}
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}>
      <div ref={pillRef} className="mo-pill">
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
            <div className="flex shrink-0 items-center gap-0.5 pb-0.5">
              <button
                type="button"
                className={iconButton}
                onClick={() => fileRef.current?.click()}
                disabled={disabled}
                aria-label={t('chat_input_attach')}
                title={t('chat_input_attach')}>
                <Paperclip className="size-4" />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ALLOWED.join(',')}
                className="hidden"
                onChange={event => void onFiles(event)}
              />
              {onMicClick && (
                <button
                  type="button"
                  className={cn(iconButton, isRecording && 'bg-destructive/20 text-foreground')}
                  onClick={onMicClick}
                  disabled={disabled || isProcessingSpeech}
                  aria-label={isRecording ? t('chat_stt_recording_stop') : t('chat_stt_input_start')}
                  title={isRecording ? t('chat_stt_recording_stop') : t('chat_stt_input_start')}>
                  {isProcessingSpeech ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
                </button>
              )}
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
                  aria-label={t('chat_buttons_send')}
                  title={t('chat_buttons_send')}
                  data-ready={ready ? '' : undefined}
                  className="mo-send">
                  <ArrowUp className="size-[18px]" strokeWidth={1.75} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
