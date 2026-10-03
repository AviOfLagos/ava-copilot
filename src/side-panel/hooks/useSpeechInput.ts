import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@extension/i18n';

// The longest recording, so a forgotten microphone does not run on
const MAX_RECORDING_MS = 2 * 60 * 1000;

/**
 * Records from the microphone and hands the audio to `send` as a data URL, for the background to
 * transcribe. Asks for microphone permission in a small window the first time.
 */
export function useSpeechInput(send: (audio: string) => void, onError: (message: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
      clearTimer();
    },
    [],
  );

  const toggle = useCallback(async (): Promise<void> => {
    if (isRecording) {
      if (recorderRef.current?.state === 'recording') {
        recorderRef.current.stop();
      }
      clearTimer();
      setIsRecording(false);
      return;
    }

    try {
      const permission = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (permission.state === 'denied') {
        onError(t('chat_stt_microphone_permissionDenied'));
        return;
      }
      if (permission.state !== 'granted') {
        // The permission page asks; the user presses the mic again afterwards
        await chrome.windows.create({
          url: chrome.runtime.getURL('permission/index.html'),
          type: 'popup',
          width: 500,
          height: 600,
        });
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        if (chunksRef.current.length === 0) {
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          try {
            setIsProcessingSpeech(true);
            send(reader.result as string);
          } catch {
            onError(t('chat_stt_processingFailed'));
            setIsProcessingSpeech(false);
          }
        };
        reader.readAsDataURL(new Blob(chunksRef.current, { type: 'audio/webm' }));
      };
      timerRef.current = window.setTimeout(() => {
        if (recorderRef.current?.state === 'recording') {
          recorderRef.current.stop();
        }
        setIsRecording(false);
        timerRef.current = null;
      }, MAX_RECORDING_MS);
      recorder.start();
      setIsRecording(true);
    } catch (error) {
      let message = t('chat_stt_microphone_accessFailed');
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') message += t('chat_stt_microphone_grantPermission');
        else if (error.name === 'NotFoundError') message += t('chat_stt_microphone_notFound');
        else message += error.message;
      }
      onError(message);
      setIsRecording(false);
    }
  }, [isRecording, send, onError]);

  return { isRecording, isProcessingSpeech, setIsProcessingSpeech, toggle };
}
