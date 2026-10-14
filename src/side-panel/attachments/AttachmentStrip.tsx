import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { t } from '@extension/i18n';
import type { MessageAttachment } from '@extension/storage';

/**
 * The pictures and videos kept with a message, as thumbnails under it. A picture opens full size in a new tab;
 * a video shows its length (only its frames were kept).
 */
export default function AttachmentStrip({ attachments }: { attachments: MessageAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const made = Object.fromEntries(attachments.map(item => [item.id, URL.createObjectURL(item.thumb)]));
    setUrls(made);
    return () => Object.values(made).forEach(url => URL.revokeObjectURL(url));
  }, [attachments]);

  const open = (item: MessageAttachment) => {
    if (!item.blob) return;
    const url = URL.createObjectURL(item.blob);
    window.open(url, '_blank', 'noopener');
    // The new tab has loaded it by then
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <ul className="mt-1.5 flex flex-wrap justify-end gap-1.5" aria-label={t('chat_attach_media')}>
      {attachments.map(item => {
        const label =
          item.kind === 'video'
            ? t('chat_attach_video', [item.name, String(Math.round(item.durationSec ?? 0))])
            : item.name;
        const image = urls[item.id] ? (
          <img src={urls[item.id]} alt={label} className="size-16 rounded-lg border object-cover" />
        ) : (
          <span className="bg-secondary block size-16 rounded-lg border" />
        );
        return (
          <li key={item.id} className="relative" title={item.name}>
            {item.kind === 'image' && item.blob ? (
              <button
                type="button"
                onClick={() => open(item)}
                aria-label={t('chat_attach_open', [item.name])}
                className="block rounded-lg">
                {image}
              </button>
            ) : (
              image
            )}
            {item.kind === 'video' && (
              <span className="bg-background/80 absolute bottom-1 left-1 flex items-center gap-0.5 rounded px-1 font-mono text-[9.5px]">
                <Play className="size-2.5 fill-current" aria-hidden="true" />
                {Math.round(item.durationSec ?? 0)}s
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
